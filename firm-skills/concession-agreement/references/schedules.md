# The schedules

What each of the master's twenty-five schedules contains as it stands, what it needs from the deal,
and who supplies it. "Stub" means the schedule is a heading and `[To Be Attached Hereto]`; the
build leaves the stub and reports it. "Drafted" means the master carries wording that the build
fills or that the drafter adapts.

| Sch. | Title | State | Needs | From |
|---|---|---|---|---|
| A | Scope of the Project | stub | technical scope | client / technical adviser |
| B | Specific Definitions | drafted, 39 blanks | every deal-specific value | intake |
| C | Development Works: Engineering, Design & Construction Drawings | drafted, one `[insert …]` list | drawing categories | technical adviser |
| D | Project Facilities | stub | facilities list | technical adviser |
| E | Project Development Completion Schedule | stub | milestone dates | Financial Model / technical |
| F | Project Site | stub | site map | client |
| G | Completion Tests Matters | stub | test list | technical adviser |
| H | O&M Requirements | stub | O&M specification | technical adviser |
| I | Insurance | stub | insurance schedule | insurance adviser |
| J | Specific Matters Relating to Relief Events | drafted | review only | — |
| K | Corporate Documents | stub | list | drafter |
| L | Financing Matters | drafted, Step In Rights blank | financing terms | lenders' counsel |
| M | Form of O&M Performance Security | stub | bank form | drafter / bank |
| N | Independent Auditor / Engineer Terms of Reference (Parts I, II) | stub | ToRs | client |
| O | Form of Vesting Certificate | stub | form | drafter |
| P | Equity Matters | **option table** A / B / C | choose architecture | client / EY |
| Q | Price Escalations | drafted | confirm Escalable Items | client |
| R | Revenue Matters | drafted, 6 blanks | band percentages | Financial Model |
| S | Notices | stub | addresses | intake |
| T | Termination Payments | drafted, 2 choices | CP failure percentages | client |
| U | Financial Model | stub | model | financial adviser |
| V | Illustrations | stub | worked examples | financial adviser |
| W | Agency Financial Instrument | drafted, Part B blank | extension mechanism, or delete | client |
| X | Change in Control etc. | drafted | review only | — |
| Y | Agency Specific Permits | stub | permit list | client |

## Schedule P: the one that cascades

The master offers three equity architectures and, for each, a column headed "Schedule Y Treatment"
that instructs deletions elsewhere in the document:

| Option | Structure | What the master says to do |
|---|---|---|
| A | Sponsor holds 100% Class A; no Agency equity | Delete all Class B Share references, the EFU Agency component, `Agency Funding Amount`, the Class B Dividends mechanism |
| B | Class A + Class B (baseline) | Use as drafted; fill `Agency Funding Amount` and `Sponsor Base Equity Amount` from the Financial Model |
| C | Class A + one Class E golden share | Replace "Class B Shares" with "Class E Shares" throughout; remove the dividend mechanism; add step-in and information rights |

**The build does not execute these cascades.** Choosing Option A means deleting definitions in
Section 1.1 and Schedule B, list items in the Conditions Precedent (which renumbers what follows),
and rows in Schedule P itself, and inferring "all Class B Share references" by search both
over-deletes and under-deletes. The skill records the choice, leaves the option table intact, and
lists the cascade as manual actions in the report. Do the deletions in Word with tracked changes
on, then run `check_agreement.py` again.

## Conditional amendments

Eight footnotes in the master are drafting instructions of the form
`[Conditional Amendment — If Islamic Financing] Replace "bank guarantee" with …`. They cover:
financing present or absent, Islamic financing, tax regime fixed in the bid, and whether the Agency
gives a financial instrument. `read_template.py` extracts them; the intake asks whether each
condition applies; the build reports the confirmed ones as manual actions and keeps the footnote
until the amendment has been made. It never infers a condition from the deal facts.

## Known gaps in the schedule set

- Schedule B's own instruction sentence says its `[●]` blanks are "mandatory fill-ins before
  issuance of the RFP". Treat every one left open as a blocker for issue, not a nicety.
- A directive in Schedule B refers to a `Schedule Z` that does not exist.
- Schedule T's two termination percentages are bracketed defaults (`[Fifty percent (50%)]`) and are
  treated as blanks; confirm rather than accept them.
