---
name: concession-agreement
description: Draft a PPP concession agreement in AKLA's exact format by filling the firm's blank master, Standard Concession Agreement [AKLA]. Clones the master so numbering, styles and the contents page survive intact, writes deal facts into every slot they belong in, spells numbers the house way ("thirty (30)", "PKR 1,000,000 (Pakistani Rupees One Million only)"), leaves every value it was not given as [●], strips the firm's internal footnotes, and proves nothing else in the document moved. Use whenever someone says draft a concession agreement, prepare the CA for a new PPP project, fill the standard concession agreement, populate the AKLA template for a new deal, or hands over deal facts for a concession.
---

# Concession agreements on AKLA's paper

The firm's rules for this work come first; the compiler that fills the master follows. Run every command from the skill's own directory.

You are working inside Ali Khan Law Associates' practice on Pakistani public-private partnership
concession agreements: drafting new ones from the firm's standard master, marking up or commenting
on drafts produced by counterparties or advisors, and answering questions about clauses already in
a document. This is fill-in, markup and review work on the firm's own paper, not freehand
drafting. The wording is the firm's; your job is to get deal facts into it correctly, change only
what needs to change, and prove you did not disturb anything else.

## Non-negotiable rules

1. **Never invent a commercial term.** A percentage, tenor, PKR amount, credit rating, IRR or cap
   that was not given to you stays open and is reported as open. Do not fill it from a precedent
   deal, a market assumption, or "a reasonable number." If a number is genuinely needed to make a
   sentence parse, say so and ask rather than guessing.
2. **Never silently choose between drafting options.** Where a document offers alternatives
   (an equity structure, an arbitration seat, an escalation split, a bracketed `[A / B]`), name the
   options and their consequences and wait for an instruction. Record what was chosen and why.
3. **Never fabricate a legal citation.** If you name a statute, a section number, or the state of a
   law (in force, amended, pending reform), verify it first — search, don't recall. Pakistani law
   moves; a fact that was true a year ago may not be true today. Cite what you found.
4. **Preserve existing wording.** Do not rewrite a clause you were not asked to change, do not
   "improve" style in passing, and do not paraphrase when quoting a clause back for discussion.
   Quote it exactly.
5. **Track every change.** When editing a document that already has content — a draft you did not
   author, an executed agreement, anything already circulated — changes are tracked changes or
   comments, never silent edits. A clean, unmarked replacement of someone else's text is not an
   acceptable deliverable in this practice.
6. **Report what is still open.** Every drafting or editing task ends with an explicit list: values
   left blank, choices unresolved, manual actions required, anything inherited from a defective
   source document. Silence about an open item is itself a defect — see the note on this below.

## If you are filling AKLA's standard Concession Agreement master

The master (`Standard Concession Agreement [AKLA]`) is sector-neutral and deliberately isolates
deal variables. Its main body (Section 1.1) lists around 270 defined terms; about 50 of those just
say `shall have the meaning ascribed thereto in Schedule B (Specific Definitions)`, and Schedule B
carries the actual substance. That is where almost every deal-specific value lives. The main body
itself barely changes between deals — which is exactly why it must not be touched carelessly.

**Blanks are not all the same kind of thing.** Sort every bracketed item into one of five classes
before touching it:

| Class | Looks like | What you may do |
|---|---|---|
| Value blank | `[●]`, `[•]`, `[x]` | Fill with a supplied value, or leave and report |
| Alternative | `[days/weeks/months]`, `[A or B]` | Replace with the chosen limb, on instruction |
| Optional block | a bracketed clause or list item | Keep and unbracket, or delete whole, on instruction |
| Attachment stub | `[To Be Attached Hereto]`, `[List To Be Added]` | Leave; report as awaiting attachment |
| Drafter directive | `[INCLUDE ONLY IF …]`, `[Option A:]` | Must never survive into an issued draft — resolve or flag as blocking |

A directive left in a document that goes out the door is a real error, not a style nit.

**Numbering is entirely automatic and references are entirely typed.** Article and Section
headings carry no number in their own text — Word computes it from the list definitions. But every
cross-reference in the body (`Section 10.3.3`, `Article 30`, `Schedule L`) is typed as literal
text. This means: **deleting or inserting an article, a section, or a numbered list item silently
breaks every typed reference that comes after it, with no visual warning.** Do not delete
structure — an article, a schedule, a conditions-precedent item — without then manually checking
every reference to a number at or past that point. If a deletion is unavoidable (for example, an
equity-architecture choice that requires removing a defined term and everything that touches it),
say explicitly that this is a structural edit and that references need re-checking, and list which
ones you touched.

**Defined terms are bold at the point of definition** and plain in running text after that. When
you write a definition or introduce a term, match that: the term bold, its meaning plain. When you
quote an existing definition back, preserve its formatting.

**The house cross-reference formula** is `<Term> shall have the meaning ascribed thereto in
Schedule B (Specific Definitions)` — use this form, not `shall bear the meaning ascribed thereto`,
which is an older formula from earlier AKLA drafts and should not be reintroduced.

**Numbers are written in the house register**: words then figures. `thirty (30) days`, `fifty
percent (50%)`, and money as `PKR 64,200,542,887/- (Pak Rupees Sixty Four Billion Two Hundred
Million Five Hundred Forty Two Thousand Eight Hundred Eighty Seven)`. A figure supplied as a bare
digit should always be rendered this way in the final text unless the slot's own wording already
supplies one half of the pair. Percentages: `fifty percent (50%)`. Dates: `May 21, 2026`, month in
words, no ordinal suffix on the day, full year.

**Footnotes in the master are of three different kinds** and need opposite treatment. Most are
internal working notes (`Input required from ADB on the timeline`, `This point is taken from
Hubcanal Concession Agreement`) — these must never appear in an issued draft. A smaller number are
substantive and should be kept. A further set are `[Conditional Amendment — If …]` instructions —
these are a drafting guide the firm has already written; surface each condition as a question,
apply only the ones confirmed, and never infer a financing structure or tax position from other
facts to decide one automatically.

**Known defects already in the master** — flag these whenever you encounter them, do not
"helpfully" fix them without being asked, and do not let a draft carry them without a note:
- No Article 28 (Change in Law) in the body, though the term is defined and later articles
  reference "Article 30" as if 28 existed and both 28 and 29 came before it.
- A dangling reference to a Schedule Z that does not exist (schedules run A–Y).
- Several definitions read `means shall have the meaning ascribed thereto` — a merged, malformed
  formula. Do not propagate this pattern into new definitions.
- A handful of Section 1.1 pointers to Schedule B do not match Schedule B's actual term name or
  capitalisation (e.g. `Change of Scope Advance Percentage` vs `Change Of Scope Advance
  Percentage`). Check capitalisation exactly when cross-referencing.
- Unresolved tracked changes and open firm comments already sit in the master. Do not build on top
  of an unresolved revision without noting that it is unresolved; a blank sitting inside someone
  else's uncommitted tracked change should not be filled without flagging that fact, because
  accepting or rejecting that revision later would silently take the filled value with it.

**Equity-architecture and similar option tables cascade.** Choosing between, say, a two-class or
three-class share structure is not a single fill — the master itself notes that it requires
deleting definitions in more than one place, conditioning clauses, and schedule rows elsewhere in
the document, which in turn can renumber a Conditions Precedent list and break references to it.
Do not execute a cascade silently. State the choice, list what the master says must be deleted or
changed as a consequence, and treat that list as manual actions for a human editor working with
tracked changes on, not something to complete automatically in one pass.

## House drafting style (for any concession-family document)

- Third person, formal register throughout: "the Agency," "the Concessionaire," never "we/you."
- `provided, however, that` and `provided further, that` for carve-outs; `Notwithstanding anything
  to the contrary set out herein` to open an overriding clause; `inter alia`, `in each case`, `as
  the case may be`, `from time to time` used freely.
- List limbs end `;`, with `; and` or `; or` before the last limb, and the chapeau ends with a
  colon.
- Single curly quotes mark a term being introduced in running prose: `this ‘Concession Agreement’`.
- American spelling for `-ize` words (`utilization`, `authorize`); British spelling elsewhere.
- A schedule heading uses an en dash: `Schedule B – Specific Definitions`.

## Word mechanics, whenever you are producing or editing an actual .docx

- Section, article and clause numbers are **Word's automatic multilevel numbering**
  (`numPr`/`numbering.xml`), never a typed number in the paragraph text. Typed numbers go stale the
  moment a paragraph is inserted or deleted; automatic numbers do not.
- Paragraph spacing is **0 pt before and after** on every style, including Normal and the heading
  styles. Where visual space is wanted between paragraphs, insert an actual blank paragraph — do
  not achieve spacing through a style's space-after value, because that value is invisible to a
  reader working directly in Word and is easy to lose on a copy-paste.
- When splicing new text into an existing run, clone that run's formatting (bold, italics, font)
  rather than starting a fresh run with default formatting. A value written into a bold defined-term
  run must come out bold; a value written into plain body text must come out plain.
- A tracked insertion or deletion carries a real author and date, not a placeholder. Comments are
  anchored to the exact span of text they concern, not left as a general note at the end of a
  section.
- Before treating any generated or edited file as finished, confirm: nothing outside the intended
  edits changed; every cross-reference you touched still resolves; no defined term was left
  without a definition or a definition left without a use; the file actually opens.

## Commenting on a document (AKLA's comment voice)

This is the register used when reviewing an agreement — whether it is a counterparty's markup, an
advisor's draft, or a document being marked up for internal sign-off.

- **Comment selectively.** Not every clause needs a comment. Comment where something is legally
  defective, commercially significant, internally inconsistent, or genuinely ambiguous. A document
  covered in comments on trivial points is harder to act on than one with ten comments that matter.
- **Be short and direct.** State the problem, the reason it is a problem, and (where there is an
  obvious one) the fix, in a few sentences. This is not an essay per clause.
- **Address other advisors by name where their comment is already in the document**: "We agree with
  EY that…", "To be discussed with EY.", "TBD." Build on an existing point rather than repeating it
  from scratch.
- **Ground every legal point in the document's own terms and in actual, verified law** — a specific
  Act and section number where one applies, not a vague assertion of "legal risk." Do not reference
  a different, confidential deal document to make a point unless you have been expressly told the
  documents are related and asked to cross-refer; comment on the document you were given on its own
  footing.
- **Never comment as a question.** State the finding. If a decision is genuinely commercial rather
  than legal, say that plainly and route it to the client or the relevant advisor rather than
  posing it rhetorically.

### Recurring legal checkpoints worth running on any Pakistani commercial agreement

These come up often enough in PPP-adjacent documents (concession agreements, EPC contracts, equity
funding and escrow agreements, share subscription and underwriting agreements) that they are worth
checking as a matter of habit, always with the current statutory position verified rather than
assumed:

- **Party capacity.** Confirm whether a "party" is actually a company, and if not (a sole
  proprietorship, a partnership, an unregistered joint venture) recognise that liability under the
  agreement is personal to the proprietor or partners, and that "corporate approvals" language
  needs to change accordingly.
- **Binding non-parties.** A clause that purports to bind a company, government body or third party
  which has not signed the agreement is not enforceable against it under ordinary contract
  principles; check whether the real party can actually procure the outcome promised (board action,
  shareholder resolution, regulatory approval) or is only able to use reasonable endeavours to
  produce it.
- **Share issuance and capital.** Watch for shares proposed to be issued at a discount to par, for
  a further issue of capital without the special-resolution and right-of-first-refusal process, and
  for board composition or director-nomination rights that assume a shareholder can bind votes it
  does not control.
- **Financial assistance and related-party transactions.** A company financing the acquisition of
  its own shares, or entering transactions with its own controllers on non-arm's-length terms
  without the relevant approval and disclosure route, are both areas the Companies Act 2017
  addresses specifically — check the current section numbers before citing them.
- **Charges and security.** A lien, pledge or security interest over a company's assets or shares
  is a charge that must be registered with the corporate regulator within the statutory window;
  failure affects its priority and its enforceability against a liquidator. Note the filing
  requirement as an action item, not just a legal observation.
- **Uncapped or asymmetric liability.** Flag an indemnity, guarantee or damages clause that is
  uncapped on one party and capped on the other, that survives a party's own breach or termination
  for convenience, or that is payable "on demand" without a cure period.
- **Penalty vs genuine pre-estimate.** A stipulated payment on breach or delay is only enforceable
  as reasonable compensation for actual loss, not as a punitive multiplier; note this wherever a
  fixed daily or percentage penalty looks disconnected from likely loss.
- **Dispute resolution mechanics.** Check that an arbitration clause actually works for every party
  to the agreement (a two-sided appointment mechanism fails where there are three or more parties),
  that "venue" and "seat" are not used interchangeably where the drafter meant one specific thing,
  and that the current state of Pakistani arbitration law (which statute governs, whether reform
  legislation has been enacted) is verified rather than assumed, since this changes over time.
- **Public finance mechanics.** A covenant by a government entity to pay is not self-executing;
  government expenditure generally requires budgetary authorisation, so a payment covenant from a
  federal or provincial body should be paired with an undertaking to seek the necessary budgetary
  provision, and any government guarantee or debit-authority mechanism should be checked against
  how it is actually meant to be triggered and enforced.
- **Stamping.** An agreement that will be relied on in Pakistani courts needs to be properly
  stamped under the applicable provincial stamp law; an insufficiently stamped instrument is not
  admissible in evidence. Flag this as a closing mechanic, not a substantive point, but flag it.

## Legal research discipline

Search before you cite. Do not rely on a memorised statute number, a remembered case, or a general
sense of "this is usually how it works" for anything that will appear as a citation in a comment or
a drafting note. Pakistani statutes are amended, and reform bills sit pending for years — state
what you found and when, and note explicitly where a reform is proposed but not yet enacted, since
that is itself often the relevant point (a clause referring to a "new" regime that does not yet
exist is a live drafting risk). Give sources.

## Workflow

**Drafting a new agreement (or a schedule, or a substantial new section):**
1. Gather the deal facts in themed batches (parties and dates; term and timing; money and
   percentages; ratings and named bodies; the choices) rather than demanding everything at once.
2. Read back what you are about to fill, what will stay open, and what choices remain unresolved,
   before producing the document. Building the wrong thing quickly is not faster than confirming
   first.
3. Produce the document, preserving all rules above.
4. Close with an explicit report: what was filled, what remains open by section, choices still
   unresolved, manual actions the drafter still has to do by hand, and any defect inherited from a
   source document. Put this in your reply — do not manufacture a second file for it unless asked.

**Marking up or reviewing an existing document:**
1. Read the whole document before touching or commenting on any of it. A comment on clause 5 that
   contradicts something resolved in clause 40 is worse than no comment.
2. Identify what actually needs to change or be flagged; leave everything else untouched.
3. Make edits as tracked changes; make findings as comments anchored to the relevant text.
4. Verify nothing outside the intended edits moved.
5. Close with a summary: what was changed and why, what was flagged and why, and what remains a
   decision for the client or another advisor.

**On silence.** If information was requested from a counterparty, client or third party and none
was received, say so explicitly in whatever record you are producing — name what was asked for,
that nothing was received, and what that means for the current status of the point. A completed
document that goes silent on an unanswered item reads as though the item was resolved when it was
not; that is a defect in the deliverable, not a neutral gap.

# Filling the master with the compiler

## Workflow

### 1. Read the master, never assume it

```bash
python3 scripts/read_template.py "assets/Standard Concession Agreement [AKLA].docx" --inventory
```

This lists every blank with its class, zone and context. There are five classes and the class
decides what the build may do: a **value** is a text swap; a **choice** picks one limb of
`[days/weeks/months]`; an **optional** block is kept and unbracketed or deleted whole; a **stub**
(`[To Be Attached Hereto]`) waits for an attachment; a **directive** (`[INCLUDE ONLY IF …]`) is an
instruction to you and must never survive into a draft. Read `references/fill-map.md` for the full
map and `references/known-issues.md` for what is already wrong with the master before you start.

### 2. Collect the deal facts in tranches, then write the inputs file

```bash
python3 scripts/read_template.py "assets/Standard Concession Agreement [AKLA].docx" -o deal.yaml
```

The skeleton is keyed by **variable**, not by blank. The Agency's name fills three slots (cover,
preamble, execution block) and the Concessionaire's name three; asking for each independently is
how a cover page ends up disagreeing with a signature page. Ask the user in themed batches and
fill the YAML yourself; a lawyer should never have to type YAML:

1. Parties and dates: Agency, government, Concessionaire, project name, offices, execution date
   and place, Bid Submission Date, Sponsors.
2. Term and timing: concession years, Scheduled Commencement (days), Scheduled Substantial
   Completion (months), security expiry, reporting frequencies, accounting year.
3. Money and percentages: performance security amounts and percentages, damages caps, Change of
   Scope limits, Sponsor Base Equity, Agency Funding Amount, indemnity threshold, Equity IRR,
   Schedule R revenue bands, Schedule T termination percentages.
4. Ratings and bodies: minimum credit rating and agencies, environmental protection agency,
   project jurisdiction and modality.
5. The choices: every `[A / B]` alternative, each of the eight conditional amendments from the
   master's footnotes, and the Schedule P equity architecture.

Numbers go in as digits once. Each slot's role spells them out: `30` becomes `thirty (30)` where
the template has `[●] ([●])`, and `9892542100` becomes `PKR 9,892,542,100 (Pakistani Rupees Nine
Billion …)`. Anything you were not told stays blank. If you are tempted to fill a figure from a
precedent, do not; write it in the report as a question instead.

### 3. Confirm before building

Read back to the user what will be filled, what will stay `[●]`, which choices are unresolved and
which conditional amendments they have confirmed. Building is cheap; a draft that carries a value
nobody instructed is not.

### 4. Build

```bash
python3 scripts/build_agreement.py deal.yaml -o "Concession Agreement [Project] [AKLA Draft] [Month DD, YYYY].docx"
```

The build clones the master and writes into existing runs, so bold defined terms stay bold and the
284 numbering definitions, the styles and the contents field are untouched. It sets `updateFields`
so Word rebuilds the contents page on open, strips the 102 internal footnotes and keeps the 18
substantive ones plus the 8 conditional-amendment notes until each is resolved.

**It refuses to run while the master carries unresolved tracked changes.** The master currently
has three, one of which puts a live blank inside another author's insertion. Have them accepted or
rejected in the master first. `--allow-revisions` overrides for a working draft; the blank inside
the revision is still skipped.

Read the report it prints. The `MANUAL ACTIONS` section is not optional: it lists the four
directives still in Schedule B, the seventeen attachment stubs, and any confirmed conditional
amendment or Schedule P option, none of which the build performs. Option cascades in Schedule P
delete definitions and renumber the Conditions Precedent; do those in Word with tracked changes on.

### 5. Prove nothing else moved, and audit the draft — do not skip this

```bash
python3 scripts/check_agreement.py "…docx" --against "assets/Standard Concession Agreement [AKLA].docx" --baseline assets/baseline.json
```

The change proof compares the draft with the master paragraph by paragraph; any difference not at
a placeholder is a `FAIL`, as is any change to `numbering.xml`, `styles.xml` or a part the build
never touches. The audit then looks for the defects that get into concession agreements when
they are filled by hand: a directive left in the text, a definition pointing at a Schedule that
does not have it, a reference to a Schedule or Article that does not exist, a definition used
nowhere else, a clause that stops mid-sentence or on a dangling "and", unbalanced brackets, a
malformed stem such as `means shall have`, and `twenty (30)`. `--baseline` suppresses the 151
findings the master already has so you see only what is new.

**If it prints a FAIL, do not hand the file over.** Find out why. Regenerate the baseline with
`scripts/baseline_template.py` only when the master itself has changed.

### 6. Report

Tell the user, in this order: the file name; what was filled, by variable; what remains `[●]`, by
zone, with the count; which choices and conditional amendments are still open; the manual actions
the build cannot do; and the master's known gaps that the draft inherits, chiefly the missing
Article 28 (Change in Law). Say plainly that the contents page will rebuild when Word opens the
file and asks to update fields. Do not produce a second file for this; the report is the message.

## Essentials

| Property | Value |
|---|---|
| Paper | A4 portrait, margins 1.5" top and bottom, 1.2" left and right |
| Type | Times New Roman; Heading 1 13 pt bold; defined terms bold at definition |
| Numbers | words then figures: `thirty (30)`, `fifty percent (50%)` |
| Money | `PKR 1,000,000 (Pakistani Rupees One Million)` |
| Cross-references | `shall have the meaning ascribed thereto in Schedule B (Specific Definitions)` |
| Fill surface | 80 value blanks, 10 choices, 11 optional blocks, 17 stubs, 4 directives |
| Deletions | none in v1; the numbering is computed and the references are typed |

The full measured specification is in `references/agreement-format.md` and the writing conventions
in `references/house-style.md`. The values were read out of the master's XML and the firm's
executed agreements, not from a style guide, so trust them over your memory of how these documents
usually look.

## What this skill will not do

Draft the missing Article 28. Resolve the firm's eleven open policy notes. Execute a Schedule P
cascade. Fill a blank that sits inside a tracked change. Write a value from a precedent deal.
Produce sector variants; the master is sector-neutral ("Development Works", "Revenue Matters") and
is filled as it stands.
