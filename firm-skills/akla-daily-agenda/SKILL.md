---
name: akla-daily-agenda
description: Write an AKLA employee's end-of-day Daily Agenda and Daily Timesheet as a Word file in the firm's exact format. The person says in plain words what they did today, how long each item took and what they will do tomorrow; this turns that into the two-page house document (Daily Agenda for the next working day, navy/gold Daily Timesheet table for today), names the file the firm's way and checks it before handing it over. Use whenever someone says make my agenda, do my timesheet, here is what I did today, agenda for tomorrow, daily agenda, or gives an end-of-day account of their work.
---

# AKLA Daily Agenda

Every AKLA employee ends the day by sending a Word file with two pages: tomorrow's
**Daily Agenda** and today's **Daily Timesheet**. The format is fixed and is described
in `references/agenda-format.md`. Your job is to take the person's plain account of
the day, write it up in the firm's wording, build the file and verify it.

**You draft the wording; you never invent the facts.** Transactions, tasks, hours,
billable hours and who things are pending with come from the person. If something is
missing, ask. Do not guess hours, do not pad descriptions, do not add a transaction
they did not mention.

## 1. Collect what you need

Read the whole message first; most people give everything in one go. Then check
you have all of the following, and ask for whatever is missing in **one** short list
(not a question at a time, they are trying to go home):

1. **Who** — full name and role label (`Senior Counsel`, `Associate`, `Intern`). If
   `~/.akla-agenda.yaml` exists, read it: it holds `name`, `role`, `closing` and
   `ak_column` and you must not ask for them again. If it does not exist, offer to
   create it after the first build so they never repeat themselves.
2. **Today's work** — for each item: the transaction, what was done, hours, and
   whether any of those hours are billable (and whether billable to the client or
   "AK billable"). Hours are mandatory for every row. If they give a total but not a
   split, ask for the split.
3. **Tomorrow's plan** — for each transaction: what they will do, what the finished
   deliverable is, and its current status (default `Pending with me.`).
4. **Dates** — timesheet date defaults to today, agenda date to the next working day
   (Monday after a Friday). If they say "this is for Monday" or are filing late, set
   both explicitly.

If the person has clearly said everything, do not ask anything: build.

## 2. Write the YAML

Write the spec to the scratchpad (or alongside the output if they named a folder),
following `examples/example.yaml`. Drafting rules:

- **Transaction names**: use the firm's short names exactly as the person said them
  (`M6`, `PTQ`, `MEW`, `Parking Plaza`, `Zorlu`, `Artistic – DISCOS Acquisition`).
  Agenda calls, admin, internal discussions, timesheets and invoices go under
  `Internal`.
- **Scope of Task**: one sentence, what will be done, present-participle or
  imperative (`Finalising the authority letter for the EPC contract.`). If the
  deliverable has a defined name the person uses, keep it.
- **Complete Deliverable**: a noun phrase for the finished output (`Revised term
  sheet.`). `N/A.` if the task is only a discussion or a call.
- **Day Deliverable**: what tomorrow actually produces. Same as the complete
  deliverable unless the person says the task spans several days.
- **Status**: `Pending with me.` unless told otherwise (`Pending with me & Moiz.`,
  `To be started by Mr. Umer.`, `Discussion with Boss.`, `With Boss for review.`).
- **Timesheet descriptions**: past tense, specific, one sentence per item
  (`Reviewed and finalised the mark-up on the C&I contract and shared the same with
  Mr. Umer for onward circulation.`). Several items on one transaction go in as a
  YAML list; the builder stacks them `A; and` / `B.` the way the firm does. Merge
  the person's items by transaction: one row per transaction.
- **Hours**: as given. Do not round up. `billable` and `ak_billable` only when the
  person says so; otherwise leave them out (they print as `-`).
- **Internal/Administrative** bullets on the agenda page: only if they mention
  admin tasks for tomorrow (timesheet approvals, invoices, filings).
- British spelling (`finalise`), the firm's forms of address (`Boss`, `Mr. Umer`),
  no first-person pronouns except in the status line (`Pending with me.`).

Keep the person's substance. Tidy grammar and tense; do not embellish.

## 3. Build

```bash
python3 scripts/build_agenda.py agenda.yaml --outdir "<folder they want>"
```

Run from this skill's directory (`~/.claude/skills/akla-daily-agenda`). The output is
named `Daily Agenda - <Name> [<Month DD, YYYY>].docx` with the agenda date. Default
folder: the person's Desktop, unless they said where it goes. Never overwrite a file
that is open in Word; if the name exists, say so and add ` (2)`.

The builder refuses to run without a name, role, at least one agenda item, at least
one timesheet row, or any row without hours. Those are things to ask about, not to
fill in.

## 4. Check, look, and hand over

```bash
python3 scripts/check_agenda.py "<output>.docx" --render /tmp/agenda-pages
```

This prints the document as text, checks fonts, dates, labels, the navy/gold header
and that the total equals the sum of the rows, and renders the pages to PNG if
LibreOffice is installed. **Open the PNGs and look at them** before replying: two
pages, the agenda on the first, the table on the second, nothing spilling over.
Fix any `FAIL` and rerun. A `WARN` about hours is something to mention to the person,
not silently fix.

Reply with: the file path, then the agenda and timesheet as short lists so they can
read it at a glance (transaction and one-line task; transaction, hours, billable),
and the day's total. If you changed any wording materially, say so in a line. If you
had to assume a date or a status, say that too.

## Profile file

`~/.akla-agenda.yaml` keeps what never changes:

```yaml
name: Ayaan Qureshi
role: Associate
closing: allocation   # or blank
ak_column: true
```

Offer to write it the first time; after that the person only ever describes the day.

## What this skill will not do

- Fill a timesheet from a calendar or email: the hours are the person's statement.
- Decide what is billable.
- Write tomorrow's plan from today's work: it may be the same, but they must say so.
