# Drafting packs

A pack is the firm's own Word file for one kind of document, cut so the
Hub and claude.ai draft inside it rather than retyping it
(docs/drafting-fidelity-plan-2026-10-19.md, Appendix G). Two modes:

- **form** (agreements, amendments, escrow, resolutions, IE/IA, framework):
  the firm's settled text, revisions accepted, comments removed, deal facts
  blanked to `[●]`. Drafting fills the blanks; a new clause is written in
  the pack's clause kinds and carries the AKLA comment "New clause — not in
  the firm's precedents: <why>".
- **shell** (letters, memos, opinions, proposals, minutes, consents/NOCs):
  only the fixed parts (letterhead line, Ref, Dated, To, Subject, cover,
  signature block…) and one example of each kind of paragraph, its words
  replaced by `[●]`. Drafting fills the fixed parts, writes the body with
  `write` in the pack's kinds, and removes the examples.

Each pack folder holds `<kind>-pack.docx`, `kinds.json` (the paragraph,
table and footnote kinds the engine writes with; `docxAgent.js
validateKinds` is the contract), `report.json` and `REVIEW.txt`. The
folder's `packs-config.json` names every pack's base, folder, kind, mode,
title and the facts to blank. It holds client facts, so it lives with the
packs (`~/Desktop/AKLA Drafting Decisions/5 Packs to check/`), never in the
repository.

## 1. Build

On a local copy, never on the OneDrive data room:

```
python3 -I scripts/drafting-packs/build_pack.py list  "<base.docx>"
python3 -I scripts/drafting-packs/build_pack.py build "<packs-dir>/packs-config.json" letters
```

`list` prints the base's paragraphs (revisions accepted) to choose the
fixed parts, examples and kinds from; `build` cuts the pack the config
describes and writes the four files.

## 2. Verify

```
python3 -I scripts/drafting-packs/verify_pack.py "<packs-dir>/packs-config.json" letters "$(pwd)"
python3 -I scripts/drafting-packs/tests/test_build_pack.py
```

`verify_pack.py` opens the pack, runs the Hub's own reader and format
fingerprint on it and writes `REVIEW.txt`. Rayyan checks every pack in Word
beside its base before it is uploaded.

## 3. Upload

`upload_packs.mjs` makes each approved pack its type's Word standard, the
same row the admin "Word standard" upload writes, plus the pack's `kinds`,
`fingerprint` and `pack_mode` (columns added by
`supabase/migrations/20261020140000_drafting_packs.sql`, which also adds
the types Letter / Notice, Amendment Agreement, Board Resolution and
Certificate / Consent / NOC). `pack-types.json` says which type each pack
is for. It never touches the Concession Agreement or RFP standards.

Apply the migration first, then a dry run (reads and checks, writes
nothing; without credentials it checks the packs alone):

```
export SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…    # or put them in chat-service/.env
node scripts/drafting-packs/upload_packs.mjs "$HOME/Desktop/AKLA Drafting Decisions/5 Packs to check" --dry-run
node scripts/drafting-packs/upload_packs.mjs "$HOME/Desktop/AKLA Drafting Decisions/5 Packs to check"
```

`--only letters,memo` limits it to some packs; `--by <user uuid>` (or
`PACKS_UPLOADED_BY`) records who set the standards. It prints one row per
pack: `uploaded`, `unchanged` (the stored standard has the same bytes and
kinds), `kinds updated` (same file, new kinds list), `skipped` or
`refused` with the reason (a kinds problem, a missing type, a protected
type). Running it again changes nothing. A shell pack's example kinds
(from `packs-config.json`) are stored with its kinds as `examples`, so the
drafting prompt can say which blank paragraph is an example to remove.

The script imports chat-service's own modules and packages (`extractText.js`
for the text, `formatFingerprint.js` for the fingerprint, `draftingPacks.js`
for the format sentence, `@supabase/supabase-js` from
`chat-service/node_modules`), so it runs from any checkout of the
repository with chat-service's packages installed, on the Mac or the VM.

## 4. Check it drafts

In the Hub, "Draft a letter to the PD on …" (or the Draft button with the
type) opens the letter pack, fills it and writes the body; the reply ends
"Format matches the firm's standard (Letter - notice [AKLA standard])". In
claude.ai, `list_document_types` marks the type as a firm pack and
`open_standard_for_filling` lists its kinds.
