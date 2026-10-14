# AKLA Daily Agenda — the house format

Derived from five circulated agendas dated September 02, 2026 (Ahmed Yasin, Areen Ali
Shah, Haya Ansari, Ayaan Qureshi, Umer Maroof). Where the five disagreed, the majority
form was taken; the deviations are listed at the end.

## The document

One Word file, A4 portrait, 1" margins, Arial 11 throughout, two pages:

1. **Daily Agenda** — the plan for the *next working day*.
2. **Daily Timesheet** — the record of *the day just worked*.

File name: `Daily Agenda - <Full Name> [<Month DD, YYYY>].docx`, dated with the
**agenda** date (tomorrow), e.g. `Daily Agenda - Ayaan Qureshi [October 07, 2026].docx`.

Dates are written `October 07, 2026` (month name, zero-padded day, comma, year).

## Page 1 — Daily Agenda

```
                         Daily Agenda                  <- bold, 13 pt, centred

                                        Date: October 07, 2026     <- right, bold label
                                        Associate: Ayaan Qureshi   <- right, bold role label

Deliverables                                           <- bold + underlined
 • *Note: To be discussed with Boss.                   <- bullet; "*" bold, rest italic

Transaction: MEW                                       <- bold labels, justified text
Scope of Task: Finalising the authority letter for the EPC contract.
Complete Deliverable: Authority letter.
Day Deliverable: Authority letter.
Current Deliverable Status: Pending with me.

Transaction: PTQ Expressway
Scope of Task: ...
Complete Deliverable: ...
Day Deliverable: ...
Current Deliverable Status: ...

Internal/Administrative:                               <- bold + underlined, optional
 • Follow up on the September timesheet approval ...

          [Subject To Allocation Of Tasks During The Day]     <- centred
```

The role label is the person's title: `Senior Counsel`, `Associate`, `Intern`.

Every transaction gets the same five lines, in that order, each a full sentence
ending in a full stop:

| Line | What goes there | Typical wording |
|---|---|---|
| Transaction | The matter's short name as the firm uses it | `M6`, `PTQ`, `MEW`, `Parking Plaza`, `Zorlu`, `Artistic – DISCOS Acquisition`, `SADB` |
| Scope of Task | What will be done tomorrow on it, as a task | `Finalise the legal opinion ... (the SADB Legal Opinion).`, `Amendments to the term sheet.`, `Overseeing the interns on DCA amendments.` |
| Complete Deliverable | The finished output of the whole task, a noun phrase | `Revised term sheet.`, `The Zorlu Legal Opinion.`, `Amended DCA.`, `N/A.` when the task is a discussion only |
| Day Deliverable | What will actually be produced tomorrow; usually the same as above, narrower when the task spans days | `Revised term sheet.`, `First draft of the opinion.` |
| Current Deliverable Status | Where it sits now | `Pending with me.`, `Pending with me & Moiz.`, `To be started by Mr. Umer and Mr. Moiz.`, `Discussion with Boss.`, `N/A.` |

Where a deliverable is given a defined name, it is bolded in brackets the first time:
`... (the **Zorlu Legal Opinion**).` and reused by that name afterwards.

The closing line is `[Subject To Allocation Of Tasks During The Day]` (three of five
samples) or `[***The Rest Of This Page Has Been Intentionally Left Blank***]` (the two
senior ones). Both are accepted; the person's profile chooses.

## Page 2 — Daily Timesheet

Same title block (`Daily Timesheet`, 13 pt bold centred; Date; Role: Name), then one
table, style Table Grid, cell margins 115 twips:

| Sr. No. | Transaction | Matter & Description | Hours | Billable Hours | AK Billable Hours |
|---|---|---|---|---|---|

- Header row: navy fill `002060`, bold gold `FFC000` text, centred.
- One row per transaction worked on. `Internal` is the transaction for the morning
  agenda call, admin, internal discussions and firm events.
- Description is past tense and specific: `Reviewed and finalised the mark-up on the
  C&I contract and shared the same with Mr. Umer for onward circulation.` Several
  items for one transaction are stacked in the cell as `A; and` / blank line / `B.`
  (three items: `A;` / `B; and` / `C.`).
- Hours to one decimal (`1.0`, `0.8`, `6.5`); `-` where nothing is billable.
- `Total Hours` row: first three cells merged, sums under each hours column.
- `Percentage of Billable Hours` row: first three cells merged; billable ÷ total under
  the billable columns, `-` under Hours.

Interns' sheets had no AK Billable Hours column; `ak_column: false` reproduces that.

## Deviations from the samples (deliberate)

- The `Sr. No.` column is filled (`1.`, `2.`, ...). All five samples left it blank.
- Spelling is British (`finalise`, `finalised`); the samples mixed `-ise` and `-ize`.
- The empty bullet paragraph that preceded `*Note:` in every sample is dropped.
- The closing line is a plain centred paragraph, not a centred bullet.
- Percentages are computed; four of five samples left that row as `-`.
