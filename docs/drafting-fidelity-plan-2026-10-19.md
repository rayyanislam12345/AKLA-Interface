# Drafting in the firm's own form: the plan

19 October 2026. Written for the owner's request: "make better tools for drafting, which truly ensure all documents are in firm format", on three counts: **language** (the firm's style and wording), **content** (the firm's clauses in the firm's order, with room for genuinely new points) and **formatting** (laid out exactly like the firm's precedents).

The plan rests on a study of the firm's SharePoint data room: 26,864 Word files, sorted into 44 kinds of document. 39 kinds were profiled from their best recent firm-authored files, with page set-up, styles and numbering read straight from inside the Word files. A second pass on 19 October re-opened the chosen template base of every kind and checked its page size, margins and actual body font against this plan; the corrections are folded in below. It also rests on a map of how the Hub drafts today. Case law is outside this plan. Nothing here has been built yet, and nothing has been committed.

## In one paragraph

Today the Hub produces the firm's exact layout for only two kinds of document: the Concession Agreement and RFP Volume I, the two that have a Word standard. Every other draft is retyped into one generic "AKLA look" that matches no real firm document. The study shows there is no single firm look. A letter, a memo, an escrow agreement and a direct agreement each have their own page size, margins, numbering and front matter, and nearly all of them are set in Arial 11. So the fix is to **draft every document inside the firm's own file for that kind of document**, the way the Concession Agreement already works, and to **check every output against that file before it is saved**. Agreements and other forms are drafted by filling and extending a cleaned copy of the precedent. Letters, memos, opinions, minutes and other free-written documents are drafted into a "shell" of the firm's file: its letterhead, cover, signature block and styles, with the body written fresh from a set of the firm's own paragraph types. Wording comes from a short style sheet for each kind of document plus the firm's own clauses shown to the AI as examples. Structure comes from a clause list for each kind of document, built from the precedents, with a clear rule for adding something new. The whole plan comes to six slices and about 45 working days. The first 30 days deliver the ten most common kinds in the Hub and in claude.ai. The other 15 add the remaining 20 kinds, one at a time, as you settle each one's open questions.

## What an associate gets

- **Any common document in the firm's own layout, first time.** The associate asks for a letter to SEPA, a board resolution, an IE agreement or a legal opinion and gets a Word file that sits beside the firm's best recent example looking the same: same header, same fonts, same numbering, same signature block. Today this works for 2 kinds of document. After wave 1 it works for 12, and after wave 2 for about 30.
- **No more reformatting before circulation.** The draft is built inside a cleaned copy (or, for letters and memos, a shell) of the firm's own file, so there is nothing to redo. The usual job of copying text into an old file to get the formatting right goes away.
- **A plain "matches the firm's file" line on every draft,** or a list of exactly what differs. A draft that has drifted from the firm's layout is not saved into the project.
- **The firm's wording, not generic wording.** Defined terms are bold without quotation marks, numbers are written "thirty (30) days", dates are written "October 19, 2026", cross-references read "Section 2.1 (The Appointment)", and the preamble, recitals and "Now, Therefore" formulae are the firm's own. Where the AI departs from the house form, a margin comment points it out.
- **The firm's clauses, in the firm's order.** Every clause the firm always includes is present and in its usual place. Optional clauses come from a short set of questions asked one at a time, as the RFP questions already work. A clause the firm has never used before can still be added, but it is placed where it belongs and marked "New clause — not in the firm's precedents" so a partner sees it at once.
- **The same in claude.ai.** Through the connector, the associate's own Claude drafts any of these kinds of document into the firm's file and files it in the project with the same checks.

## How drafting works today

**Format.** Only the Concession Agreement and RFP Volume I are drafted inside the firm's real Word file. Everything else goes through one converter (chat-service/akla/build_docx.py), which retypes the AI's text into a generic house look: A4, Arial, a navy title banner and ruled numbered headings. That look matches no family in the data room. It has no cover page, no contents page, no schedules and no execution-block layout. Two more export routes in the website produce a third and a fourth look, and the format check only confirms that the converter did what the converter does. Four format specifications in the repo contradict each other: build_docx.py, the legal-summary skill, the DD skill and the concession skill. The only description of a precedent's formatting the AI ever sees is four sentences long.

**Language.** Outside a Word standard, the AI is told how to structure its text but not how the firm writes. It gets no rules on the register, defined-term formulae, numbers, dates or spelling. Apart from attached files, it sees about six passages that happen to match the request, offered "for phrasing". The firm's written style rules exist only inside two sandbox skills (the Concession Agreement skill and the DD skill), which the chat never reads.

**Content.** Two kinds of document have a skeleton, because they have a Word standard. One has a questionnaire: RFP Volume I, with 27 decisions written in code. Every other kind gets a generic intake ("parties, term, payment, security, governing law…") and a free draft. Nothing checks that the clauses the firm always includes are present. There is no middle way between filling a standard word for word and writing freely.

## What the firm's files show

- **There is no one house layout, but there are firm-wide constants.** Body text is Arial 11, justified, almost everywhere. Headings are Title Case in bold small caps. Defined terms are bold, in brackets, without quotation marks. Tables are navy (002060) and gold (FFC000). Unknown values are `[●]`. Page numbers read "Page X of Y". Page size and margins differ by family. Letters, memos, opinions, proposals, minutes, resolutions and certificates are A4. Agreements are split about evenly. The Concession Agreement, amendment, escrow, EF&U, term sheet, deed, consortium and offtake bases are A4. The framework agreement (MM68), security (AP81), CTA (SKM135), EPC (KPQC), direct agreement, site licence, price escalation, undertaking, O&M, power of attorney and share purchase bases are US Legal. A few bases are US Letter: the G2G MOU, the inception report and the risk matrix. Numbering schemes differ too.
- **Three bases are not in Arial.** The EF&U base (PTQ5.2) is Times New Roman 11. The G2G MOU base (EWPL39) is Times New Roman 12.5 on US Letter. The bid power of attorney (T3) keeps the RFP form's own font. The site licence and share purchase bases are Times New Roman as well; both were already flagged. Each of these needs your choice before it becomes a standard (see "What needs you").
- **Arial is usually applied word by word, not through Word's styles.** In about half the bases, Word's "Normal" style is Times New Roman. In most of the rest it is Word's default (Calibri or Aptos). Each run of text is then separately set to Arial. A converter that rebuilds a document from text cannot reproduce that. Only working inside the firm's file can.
- **Many long-form bases began as another firm's draft.** The CTA, EPC, direct agreement, site licence, undertaking and price escalation bases began with lenders' or government counsel (Haidermota, NHS, FKM) and were reworked by AKLA. The partners should confirm these as the firm's standard (see "What needs you").
- **Some families are mislabelled or thin.** "Share purchase" is mostly Sponsor Support Agreement material, and the real SPAs sit under supply agreements. Track access holds only memos, because the firm has never drafted a TAA. EPA/PPA holds no AKLA-originated PPA. NDA holds one blank firm NDA, from 2021 and with typos. Pleadings hold three genuine firm filings. Most of the "policy drafting" files are something else (invoices, gazette texts, board papers). The inventory also marked IE/IA agreements as having no Hub type, but the Hub already has "Independent Engineer's Agreement" and "Independent Auditors' Agreement" types. Only framework and agency agreements are new.
- **Known defects in the precedents.** The ADB68 Concession Agreement base has no Change in Law article. The inventory's "no tracked changes" flag is wrong for some files: AM4.2 has 111 live revisions and PR41/PR70 have 185. Every pack must therefore be re-checked for revisions when it is built.

The full precedent set, with the template base for each family, is in Appendix A. The table below is the decision view.

| Kind of document | Files | Hub type today | Template base (short) | Evidence | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Letters, notices | 2,064 | no | EWPL20 Letter to PD on OWDP (Mar 2026) | high | **Add type, wave 1** |
| Research memos, notes | 1,785 | yes | PTQ15.4 Memorandum RMC and Trustee (Oct 2026) | high (memo) | **Word standard, wave 1** |
| IE/IA, framework, agency agreements | 1,321 | IE and IA yes; framework/agency no | MM68 Framework ML-31; IE Agreement (Jun 2026) | high | **Word standard for IE and IA; add framework/agency type, wave 1** |
| Legal opinions | 579 | yes | SKM142.2 T&RA Legal Opinion (Oct 2026) | high | **Word standard, wave 1** |
| Client proposals | 567 | yes | PQE4.3 Port Qasim Electric Proposal (Aug 2026) | high | **Word standard, wave 1** |
| Amendment agreements | 549 | no | ISPC SPA Amendment Agreement (Feb 2026) | high | **Add type, wave 1** |
| Escrow / accounts | 519 | yes | SKM58 Escrow Agreement (Apr 2026) | high | **Word standard, wave 1** |
| Board resolutions, corporate | 770 | no | Board Resolution Authorizing Lead Member (Mar 2026) | medium | **Add type, wave 1** |
| Certificates, consents, NOCs | 493 | no | SC12 ICA Consent Letter (Jul 2026) | medium-high | **Add type, wave 1** |
| Meeting minutes and notes | 398 | yes | AM31 MRC Presentation Meeting Notes (Aug 2026) | high | **Word standard, wave 1** |
| Concession agreement | 788 | yes (Word standard) | ADB68 Standard CA (= the Hub's standard) | high | keep; add checks |
| RFP Volume I | 777 | yes (Word standard) | ADB58.7 M-6 RFP Vol I; Hub standard from KPQC | high | keep; add checks |
| Security documents | 1,166 | no | AP81 MODTD; LEL74 Share Pledge Amendment | medium-high | Add type, wave 2, after you pick a font lineage |
| CTA / Islamic finance | 1,205 | yes | SKM135 Musharaka Agreement A | medium-high | Word standard, wave 2 |
| EPC contracts | 719 | yes | KPQC EPC Contract Clean (Sep 2026) | medium-high | Word standard, wave 2 |
| Equity funding (EF&U) | 675 | yes | PTQ5.2 EF&U (Oct 2026) | high | Word standard, wave 2, after font decision (base is Times New Roman) |
| Due diligence | 652 | yes | AM1 Sapphire DD Vol I (Sep 2026) | high | Word standard, wave 2, after portrait/landscape decision |
| Direct agreements | 537 | yes | SKIM Concession Direct Agreement (Jun 2026) | medium-high | Word standard, wave 2, after font decision |
| Term sheets | 200 | no | MXM38 Term Sheet for SHA (Jan 2026) | medium | Add type, wave 2 |
| Undertakings | 413 | no | SKM137 Sale Undertaking A (Jul 2026) | medium-high | Add type, wave 2 |
| Deeds | 211 | no | SADB4 Deed of Trust (Jul 2026) | medium | Add type, wave 2 |
| MOUs / LOIs | 65 | no | EWPL39 G2G MOU; PC37 LOI | high | Add type, wave 2, after font and page decision (EWPL39 is Times New Roman 12.5, US Letter) |
| JV / consortium | 268 | no | AM29 Consortium Agreement (Aug 2026) | medium-high | Add type, wave 2 |
| Supply / offtake | 333 | no | NSCL41 Offtake Agreement (Jul 2026) | medium | Add type, wave 2 |
| O&M agreements | 246 | no | MEW O&M Agreement (Jan 2026) | medium-high | Add type, wave 2 |
| Price escalation | 198 | yes | MEW PEA Execution Version (2021) | medium-high | Word standard, wave 2 |
| Site licence | 149 | yes | PTQ3.2 Project Site License Agreement (Oct 2026) | high (licence) | Word standard, wave 2, after font decision |
| Powers of attorney | 195 | no | T3 Form of PoA JN & Co Part A (2026) | medium-high | Add type, wave 2. Where an RFP prescribes the form, the RFP's own file is filled. A bespoke PoA uses an Arial 11 house shell |
| Affidavits, declarations | 190 | no | MEW Qayyumabad Notarized Affidavit | medium | Add type, wave 2 |
| Checklists, matrices, CP lists | 1,117 | no | WP3.7 ICT SWM Risk Allocation Matrix (Sep 2026) | medium | Add type, wave 2 |
| Status / inception reports | 96 | yes | KBWS Inception Report (2022 draft); A35 Mandate Notes | medium | Word standard, wave 2 |
| Schedules, file tables | 1,330 | no | NSCL11 GSA Schedule of Changes (Sep 2026) | medium | Add "Schedule of changes / file contents", wave 2; agreement schedules stay inside their agreement |
| Share purchase | 117 | no | RSM SPA (Jul 2025, HMCO lineage) | medium (one deal) | Hold |
| Pleadings, petitions | 412 | no | Zorlu Modification Motion (2024) | medium (3 filings) | Hold, your call |
| NDAs | 24 | no | Template NDA Two-way (2021 form) | weak | Your call: fresh standard or skip |
| EPA / power purchase | 187 | no | NSCL41 (by analogy) | medium-low | No new type; amendments go under amendment agreements |
| Track access | 99 | no | PR71 Summary of Findings (a memo) | medium | No type; the output is a research memo |
| Policy / legislative drafting | 216 | no | PR159 PPP Framework Report | medium (reports), low (Acts) | No type; reports use the memo standard |
| Templates and masters | 60 | no | ST1 Standard Template; MEW Standing Instructions | medium-low | No type; the standing instructions master can join wave 2 later |

Not profiled, and outside this plan: firm profiles, comments on a counterparty draft (a distinct firm output, worth its own study), other unclassified agreements, presentations, and unclassified files.

## How it will work: the look of the document

**One rule: the draft is built inside the firm's own file for that kind of document, never retyped.**

1. **A "pack" for each kind of document, in one of two forms.**
   - **A form pack** is used for agreements, deeds, undertakings, powers of attorney, affidavits, resolutions and certificates: documents that are mostly the firm's settled text with facts and options filled in. The template base is cleaned once. Tracked changes are accepted, comments are removed, and deal facts (names, dates, figures, addresses) are replaced with `[●]`.
   - **A shell pack** is used for letters, memos, opinions, proposals, minutes, reports, DD volumes and tables of changes: documents whose body is written fresh every time. A form pack does not work here. A memo "blanked" of its deal facts is still the old client's analysis, and the AI would have to delete 400 paragraphs to write 400 new ones. The shell keeps only the furniture that never changes from the firm's file: letterhead or header, cover block, the Ref/Dated/To/Subject lines, salutation and closing, disclaimer footnote, contents field, signature block and footer. It also keeps one real example of each paragraph type the firm uses in that kind of document, such as heading, sub-heading, numbered paragraph 1.1, limb (a), sub-limb (i), indented quotation, table with its navy/gold header row, and footnote. The pack builder records each type's exact Word formatting in a small list that travels with the pack.

   In both forms a senior associate confirms the result, and it is uploaded as that type's Word standard through the admin flow that already exists. The file keeps its styles, numbering, theme, fonts, headers, footers and page set-up exactly as they were.
2. **A format fingerprint** is taken from the pack. It records the page size, margins and orientation of each section, fingerprints of the style, numbering, theme and font definitions, the header and footer parts, which styles each heading level uses, the body font and size, the table styles and the placeholder character. It is stored with the standard and kept for every version. (The study's `<family>.fingerprint.json` files are descriptions for people, written in different shapes per family, and eight families have none, including letters and IE/framework agreements. They are used to confirm each pack by eye. The fingerprint the check uses is computed from the pack itself.)
3. **Drafting = filling and extending the pack** with the editing engine the Hub already uses for the two standards (docxAgent), which changes paragraphs in place and never rebuilds the file. Today it has four moves: replace a paragraph, add a paragraph after another, delete a paragraph, comment. Each added paragraph copies the paragraph it is placed after. That is enough to fill blanks but not to write a document, so four new moves are added:
   - **write paragraphs of a named type**: "add these paragraphs after ¶12: a heading, two numbered paragraphs, three (a)/(b)/(c) limbs". Each takes the exact formatting of the firm's own example of that type, not of whatever paragraph it happens to follow. A new (a)/(b)/(c) list starts again at (a). This is how the body of a letter, memo or opinion is written into a shell, and how a new clause is written into an agreement;
   - **repeat a block**: copy a party paragraph, a signature block, a schedule or a clause group from the pack;
   - **add a table row**, for notices, CP tables, signature tables and issues registers;
   - **drop an optional section** together with its heading.

   Every new paragraph therefore takes its look from a real paragraph of the same type in the same file. As with the Concession Agreement today, a first draft has the AI's changes accepted before it is filed, so version 1 is a clean document and not a redline of the precedent.
4. **The format check refuses drift.** Before anything is saved, the output is compared with the pack. The style, numbering, theme and font definitions must be identical, apart from added list-restart entries that point to existing lists. Page set-up must be identical. Headers and footers must be identical apart from declared variable lines: the title, the date line and the party-initials row that some footers carry. Every text and paragraph format in the output must already exist in the pack. The only exceptions are the tracked-change marks themselves and bold added to an existing format for a defined term. The body font must cover at least 99% of the text, and the body size must cover no less of it than it does in the pack. Some firm files are only 90% 11-point, so a fixed 99% size rule would fail the firm's own precedent. There must be no typed clause numbers. If anything fails, the file is not filed, and the associate sees a plain list of what differs ("page margin changed", "3 paragraphs in Times New Roman"). If everything passes, the reply says "Format matches the firm's standard (SKM58)". The Hub already compares an edited file with its original in this way (docxChecks.js compareFormat). The change is to compare against the pack, measure the font share and refuse instead of only warning.
5. **The generic converter is retired for documents.** build_docx.py is kept only for chat notes and for kinds of document that have no pack yet. Those are labelled "general house layout, not a firm precedent". The two website export routes that produce other looks (firmDocx.ts and templateDocx.ts) are removed.
6. **Three engine faults are fixed first.**
   - When the AI adds a heading, the new heading currently takes no font from its neighbours. In most firm files Arial is set word by word over a Times New Roman or Calibri "Normal", so an added heading comes out in the wrong font.
   - A paragraph added after the last paragraph of a section copies that paragraph's section break. The result is an extra section with its own page set-up. Five of the template bases have more than one section: RFP Volume I, O&M, price escalation, EPC and DD.
   - The AI cannot start a new (a)/(b)/(c) list where it needs one. It can only continue a list it is standing next to.

   The new "write paragraphs of a named type" move fixes the first and third. The second needs the copy to leave the section break behind.

## How it will work: the wording

1. **A style sheet for each kind of document**, made from the profiles and kept short (1-2 pages). It has a firm-wide core plus the differences for that kind of document:
   - **Firm-wide core:** defined terms bold, in brackets, without quotation marks, as in "(the **Concessionaire**)". Numbers are written in words and figures, as in "thirty (30) days". Money is written "PKR 1,000,000/- (Pakistani Rupees One Million Only)". The files also use "Pak Rupees" and a lower-case "only", and inside a standard the wording already in the slot is followed (item 7 of "What needs you"). Dates are written "October 19, 2026", with a zero-padded day. Unknowns are `[●]`. Cross-references read "Section 2.1 (The Appointment)". Headings are Title Case. Party descriptions end "…which expression shall, where the context so permits, mean and include its successors-in-interest and permitted assigns". Statutes are cited "Companies Act, 2017". "shall" is used for obligations.
   - **Differences by kind of document:** the voice (memos, opinions, DD and proposals speak as "the Firm", never "we"; powers of attorney use the principal's "we"). Spelling: the Concession Agreement uses -ize, while DD and RFP use British spelling. Clause words: SPA "Clause", ESSA "Section/Article". Definition formulae: "shall bear the meaning ascribed thereto in…" against "has the meaning given to it in…". Opening and closing formulae, verbatim. The "tells" of a counterparty draft, such as quoted defined terms.

   The two skills' house-style files (concession-agreement/references/house-style.md and akla-dd-format/references/house-style.md) become two of these style sheets, so there is one source and not two. The style sheet goes into every draft prompt, in the Hub and in claude.ai.
2. **The firm's own clauses as examples.** The chosen precedents are uploaded to the precedent library under their type. Their passages already carry their heading and clause number, and are tagged with the family. When the AI writes a clause, it is shown the firm's two or three versions of that clause, found by matching the heading and not by similarity search. That costs no Voyage calls, so the free-tier limit does not bite. The reply says which firm clauses it followed.
3. **A wording check** runs on every draft, as an extension of the Hub's proof check (proofCheck.js). It checks the defined-term form, that every defined term is used and every used term is defined, the number, money and date formats, the placeholder style, that cross-references carry a heading and point to something that exists, the family's spelling, and a short banned list (quoted defined terms, "will" for an obligation in an agreement, "we" in a 2026 memo or opinion). Findings appear as AKLA margin comments plus one summary line. Wording findings do not block saving, because a lawyer may want an exception. Format findings do.

## How it will work: the clauses

1. **A clause list for each kind of document**, made from the profiles. It is an ordered list of articles and sections, each marked *always*, *optional* or *depends on a decision*, with a pointer to the firm's usual wording in the clause bank. The genuine variations found in the precedents become decisions. For example:
   - Concession Agreement: whether Article 12 is Financing, Drawings or Not Used; Revenue against Tolling in Article 17; which equity option in Schedule P; whether Change in Law is present.
   - Escrow: an arbitration seat under the Arbitration Act 1940 against SIAC.
   - Security documents: which instrument.

   The lists live in the database with the type, not in code.
2. **The questionnaire becomes data for every type.** The RFP's 27 decisions move out of questionnaire.js into the same format (the simplification review already says "only its data moves out of code"). The Concession Agreement's 10 choices, 11 optional parts and 8 conditional footnotes come from the skill's fill-map. Each new type gets its decisions from its clause list. Questions are asked one at a time, answers already in the project's documents (the index cards) are offered as defaults, and each answer switches clauses on or off.
   For a shell pack (letters, memos, opinions, minutes), the clause list is the document's fixed parts and usual sections. A letter has Ref, Dated, To, Subject, salutation, body, closing and signature. A memo has Query, Brief Answer, Analysis and Annexures, with the memo's variants as decisions. A letter has no headings, so its fixed parts are recognised by their place in the shell, not by heading text.
3. **A completeness check** runs before saving. Every *always* clause must be present and in order. Every optional clause must be present or recorded the firm's way ("Not Used"). Known gaps in a precedent are flagged, for example a Concession Agreement with no Change in Law. A missing required clause stops the draft from being filed until the lawyer confirms the omission.
4. **The rule for new concepts.** Something the firm's precedents do not have is allowed:
   - it goes at the position in the clause list where its subject belongs (a new security right goes with security, not at the end);
   - it is written to the style sheet;
   - it carries an AKLA margin comment: "New clause — not in the firm's precedents: <why>";
   - it is listed in the reply;
   - it never replaces an *always* clause.

   Rewriting a firm clause's substance gets the same marking. Filling facts into it does not.

## Where associates use it

**In the Hub chat.** The "Draft from the firm's standard" button (the front door named in the simplification review) covers every kind of document that has a pack. The type is inferred from the request and the project's index cards, so there is no list of 40 types to choose from. The draft is a project version from its first save. The reply carries the format line, the wording comments and the clause-list status. Edits to a draft go through the same engine, so the format check runs on every turn. The guided questions work for every type with decisions.

**In claude.ai, through the connector.** Connector slice 3 (filling the Word standard) is the base. It was committed to main and deployed on 19 October (7159d111). Five changes extend it:

- the existing tools return the pack's clause list, style sheet and decisions alongside the standard (`list_document_types`, `read_standard`, `get_drafting_decisions`);
- a new read-only tool, `get_clause_examples { type, heading }`, returns the firm's versions of a clause;
- `fill_standard_to_project` accepts the four new moves and runs the format check, wording check and completeness check before filing, and is refused on format drift;
- `save_draft_to_project` stays for notes, but when the text is a document of a kind that has a pack, it tells Claude to use the standard instead;
- `get_firm_rules(draft)` includes the firm-wide core of the style sheet.

All results stay under the connector's 30,000-character page size.

**The two sandbox skills** (concession-agreement, rfp-volume-i) keep working. Their style rules and fill-maps become the packs' style sheets and clause lists, so a skill draft and a Hub draft follow the same rules.

## Order of work

| # | Slice | Days | Done when (an associate can check) |
| --- | --- | --- | --- |
| 1 | Every Word draft checked against the firm's file | 5 | Fill the Concession Agreement standard in the Hub and in claude.ai, and open it in Word beside ADB68. The Styles pane, the 1 / 1.1 / 1.1.1 / (a) numbering, the header and footer, A4 and the margins are all the same, and the reply says "Format matches the firm's standard (ADB68)". A heading the AI adds is Arial like its neighbours. A clause added just before the Schedules does not create a new section. A test file with one margin changed is refused with "page margin changed". A full CA fill completes on the server inside the time limit. |
| 2 | Ten more kinds of document drafted from the firm's own file | 11 | For each of the ten (letters, memos, IE/IA and framework agreements, opinions, proposals, amendments, escrow, board resolutions, certificates/NOCs, minutes), ask for a typical document and open it beside the template base. Letterhead or header, fonts, numbering, signature block and page size are all the same. The format line says "matches". A memo on a new subject has the firm's cover, contents page, headings, (a)/(b) limbs and footnotes, and none of the precedent memo's text. A second party block or signature block added by the AI looks identical to the first. |
| 3 | Writing the way the firm writes | 5 | Draft an IE agreement. Defined terms are bold without quotes, periods read "thirty (30) days", dates read "October 19, 2026" and cross-references read "Section 2.1 (The Appointment)". The reply names the firm clauses it followed. Typing a quoted defined term and "30 days" into the draft and asking for a check produces two margin comments. |
| 4 | Every clause the firm expects, in the firm's order | 6 | Draft an escrow agreement. Its contents page lists the articles in SKM58's order. Leaving out Governing Law is caught before filing. Leaving out the Subject line of a letter is caught the same way. The arbitration question is asked once and the answer shows in the clause. A clause the lawyer asks for that the firm never uses appears in the right place with the "New clause" comment and is listed in the reply. The RFP questions still work, now from data. |
| 5 | The same in claude.ai | 3 | In claude.ai, ask for "a board resolution authorising the lead member for the KPQC bid". Version 1 lands in the project and opens beside the MEW Qayyumabad base looking the same, with the format line in the reply. The same works for a letter and a memo. |
| 6 | The rest of the firm's documents (wave 2) | 15 | Each of the 20 wave-2 kinds passes the same side-by-side check, in the Hub and in claude.ai, once you have settled its open question. |

About 45 working days in all. Slices 1 to 5 (30 days) cover the ten wave-1 kinds everywhere. Slice 6 (15 days) is about a day for each long agreement (security, CTA, EPC, EF&U, DD, direct agreement, consortium, offtake, O&M, price escalation, site licence) and half a day for each short form (term sheets, undertakings, deeds, MOUs/LOIs, powers of attorney, affidavits, checklists, status reports, schedules of changes). It can be done one kind at a time. Slice 1 builds on connector slice 3, which is live. Slice 5 needs connector slices 2 and 3 live. Slices 3 and 4 can swap order. Wave-2 packs for a kind wait for your decisions on that kind (next section).

## Decisions taken (20 October 2026)

Answered by Rayyan on the decisions page (https://claude.ai/artifact/3AgGhwZGEM14bBKaWifTRK); this section overrides anything below that disagrees.

**Template bases (wave 1).** Confirmed as proposed: letters (EWPL20), research memos (PTQ15.4), framework agreements (MM68), IE/IA agreements (MEW Qayyumabad IE Agreement, June 2026), legal opinions (SKM142.2), client proposals (PQE4.3), amendment agreements (ISPC SPA Amendment), consents and NOCs (SC12), meeting minutes (AM31). Changed:
- **Escrow:** MEW's original escrow agreement, not SKM58: `Resigned Employees/Tayyaba - Backup/Tayyaba Hyder/MEW/2. Agreement (searchable)/1. Original Execution Versions/1. Project Documents/MEW - Escrow Agreement [Execution Draft November 19 2021].docx` (SKM57 is the same agreement as AKLA's execution version, 18 Nov 2021).
- **Board resolutions:** `CTC of Board Resolution - Novation Agreement [AKLA][Second Draft][April 06, 2026].docx`, with the Helios resolutions (SC75 Extract of Resolutions, SOFR transition) as a second base.

**Notes that change a pack.**
- **Letters:** when the firm writes on someone's behalf there is no EWPL (or any client's) header or footer: the header is empty apart from "[To be printed on <client>'s letterhead]". The letter shell keeps the body layout of EWPL20 and that bracketed line, not EWPL's letterhead.
- **Memos:** annexure headings follow the subject matter; there is usually no Annexure B or C, and when there is, Annexure B is the contract or document provision and Annexure C is the law. The memo shell keeps one annexure kind, titled by the drafter.

**Layouts.** Security documents: Arial. Direct agreements: Arial (SKIM). Site licence: Arial. EF&U: Arial 11 (moved from PTQ5.2's Times New Roman). MOUs: A4 Arial 11. DD volumes: portrait. **Paper: every draft is A4**; execution versions are converted to US Legal at execution (a later "make execution version" step, not a pack choice).

**Bases from other counsel.** All six (CTA, EPC, direct agreement, site licence, undertaking, price escalation) are **re-cut** before use: "we never use another firm's drafted document as a standard". Wave 2 builds these from AKLA-drafted files only, or as fresh firm standards in the firm's agreement layout.

**Thin families.** NDA: a fresh firm standard in the look and formatting of the NSCL offtake agreement (NSCL41), with NDA content. Pleadings: left out for now.

**New kinds of document.** Wave 1: all five as proposed (letter / notice, framework / agency agreement, amendment agreement, board resolution, certificate / consent / NOC); the page's preset was left as it stood. Wave 2: all twelve approved (term sheet, security document, undertaking, deed, MOU / LOI, JV / consortium, supply / offtake, O&M, power of attorney, affidavit / declaration, checklist / matrix, schedule of changes / file contents).

**House rules.** Spelling: British -ise everywhere. Arbitration: no default; always asked as a drafting question.

**People.** Rayyan checks every pack and signs off the style sheet.

**Precedent library.** Yes: the chosen precedents are copied into the Hub's precedent library under their type (blanked before they become standards).

## What needs you

1. **Confirm the template base for each wave-1 kind of document** (the table above; full paths in Appendix A). About ten minutes each: open the file and say "yes, this is how we send it out".
2. **Pick one layout where the firm has two:**
   - security documents: Times New Roman (AP82, AP80) or Arial (AP81, LEL74);
   - direct agreements: Arial (SKIM) or Garamond (KPT);
   - site licence: Times New Roman (PTQ3.2) or Arial (SITE, MEW);
   - EF&U: keep PTQ5.2's Times New Roman 11, or move it to Arial 11 like the rest of the project documents;
   - MOUs: keep EWPL39's Times New Roman 12.5 on US Letter, or move it to A4 Arial 11 as the profile recommends (the other MOUs and LOIs are A4 Arial);
   - DD volumes: landscape, or the portrait form adopted on 14 September 2026 (note the chosen base AM1, dated 16 September, is still landscape);
   - agreement page size: about half the agreement bases are US Legal (framework, security, CTA, EPC, direct agreement, site licence, price escalation, undertaking, O&M, PoA, SPA) and half A4. Is US Legal intended for these, or should everything be A4?
3. **Approve the new document types:** letters and notices; framework and agency agreements (IE and IA already have types and only need their Word standard); amendment agreements; board resolutions; certificates, consents and NOCs (wave 1). Then term sheets, security documents, undertakings, deeds, MOUs/LOIs, JV/consortium agreements, supply/offtake agreements, O&M agreements, powers of attorney, affidavits, checklists and matrices, and schedules of changes / file contents (wave 2). Types are inferred, so this adds no picker.
4. **Accept or re-own the inherited bases.** The CTA, EPC, direct agreement, site licence, undertaking and price escalation bases began as other counsel's drafts. Should the partners treat these as the firm's standard, or have one re-cut first?
5. **The weak families: NDA and pleadings.** Each rests on one blank form (NDA, 2021, with typos) or three filings (pleadings). Write a fresh firm standard for each, or leave them out. Share purchase, EPA/PPA, track access and legislative drafting are covered elsewhere or held (table above).
6. **Who cleans each pack.** About an hour per family for a senior associate: check the blanking (or, for a shell, that only the fixed parts and one example of each paragraph type are left), check the clause list, and add the decisions. Partner sign-off on the style sheet's firm-wide core.
7. **Two house-rule questions:** the spelling convention (-ize or -ise; the files mix both), and the default arbitration forum (SKM58 uses SIAC against the firm's usual Arbitration Act 1940).
8. **Housekeeping you alone can do:**
   - (done 19 Oct: the three read-only queries were run against the live database. It holds 40 document types; Word standards exist only for the Concession Agreement and the RFP, the RFP with two files, Instructions to Bidders and Volume I; only the RFP has a questionnaire. This matches the plan.)
   - nothing large is left to free in Finder. At the 19 October re-check, all but about 40 of the data room's Word files were cloud-only again, and those 40 are the bases re-opened for that check (about 10 MB). "Remove Download" on them is optional;
   - agree that the chosen precedents (client documents) are copied into the Hub's precedent library under their type, blanked before they become standards.

## Risks and limits

- **Long standards on the small server.** The Concession Agreement has 4,106 paragraphs and 284 list definitions, and the server has one CPU. Reading the whole file, applying edits and comparing formats on it has not been timed for a full draft. Slice 1 times it. Mitigations: keep the parsed pack in memory by its fingerprint, show the AI only headings and blanks (paged), one fill at a time, and keep the existing 200-second limit.
- **Word fidelity of the editing engine.**
  - It changes one paragraph at a time and cannot yet add table rows or copy blocks (added in slice 2).
  - Paragraphs with fields or pictures fall back to a slower path. That path is a third-party library which can also rewrite the numbering part, and the format check is what catches it if it does.
  - A paragraph holding a drawn shape or text box cannot be edited at all. 23 of the 39 template bases have such shapes, mostly lines and boxes on the signature pages and covers. The pack builder lists them, and the senior associate either confirms they need no filling or replaces them with plain paragraphs before the pack is approved.
  - It cannot write footnotes today (the AI is told never to). Memos, opinions and reports cite in footnotes, so the "write paragraphs" move includes a footnote type.
  - A contents page is a Word field that is not recalculated when text changes. Every draft marks it for updating, so Word refreshes it on opening.
  - Copying a block that holds a drawing, bookmark or comment must give the copy new internal ids, or Word reports the file as damaged.
  - Comments can go only in the body.
  - The three faults in "the look of the document" (added headings in the wrong font, copied section breaks, no way to start a new list) must be fixed before any new family is trusted.
  - The format check compares text and paragraph formats one by one, so expect a few false alarms in the first week. Those are tuned, not waived.
- **Almost all of the data room is cloud-only.** At the 19 October re-check, 27,167 of the 27,370 Word paths were placeholders that download when opened, and 164 more were empty placeholders with no size. One base (OES16) could not be re-opened. Packs are therefore built once from copies uploaded to the Hub, never read live from OneDrive. The "no tracked changes" flag in the inventory is unreliable, so the pack builder re-checks every file for revisions.
- **Thin evidence.** Several families rest on one deal or one lineage, and some files sit in the wrong family (most of "policy drafting", and IE/IA marked as having no Hub type). The clause lists will miss rare clauses at first. The "new clause" rule and the associates' corrections fill those gaps over time.
- **Confidentiality.** The bases are real client documents. They must be blanked before they become standards, and the clause bank holds passages from them, so it carries the same access rule as the precedent library.
- **AI drafts and search.** Versions saved from claude.ai are filed as the associate's own and are searchable (owner decision, 19 Oct). Drafts the Hub chat saves are still marked AI-generated and skipped by the search by meaning until that rule changes too.
- **What this does not do.** It does not reformat a counterparty's draft into the firm's layout; marking up their file keeps their layout, as it should. It also does not make the firm's precedents agree with each other. Where they differ, you choose (item 2 above).

---

## Technical appendix

Code references follow the drafting map of 19 October 2026 (scratchpad drafting-study/hub-drafting-map.json). The profiles and fingerprints are in `/private/tmp/claude-501/-Users-rayyanui-AKLA---Project-Hub/fd40ffa3-5e69-41b3-bdd9-049bfb21ff92/scratchpad/drafting-study/profiles/` (`<family>.md`, `<family>.fingerprint.json`).

### A. The precedent set, per family

Paths are relative to the data room root `~/Library/CloudStorage/OneDrive-AliKhanLawAssociate/Ali Khan Law Associates - Documents/AKLA - Data Room/`. **Base** = template base (the pack is cut from it); *skeleton* = clause-order source; *language* = wording exemplar. Rejected files and their reasons are in each family's profile.

**legal_letter_notice** (no Hub type)
- **Base** `Usama - Backup/Active Transactions/EWPL/Output Water Matter/EWPL20 - Letter to PD on OWDP [AKLA][Circulation Version][March 18, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/EWPL/SEPA Matters/EWPL2 - Letter to SEPA on Extension Request [AKLA][First Circulated][April 16, 2026].docx`
- *skeleton* `Resigned Employees/Tayyaba - Backup/My Transactions/MEW/4. Retainer Work/13. Re-appropriation Purpose/0. letter drafts/1. MEW - Notification of Re-appropriation Purpose [AKLA Draft Dec 09, 2025] v5 (clean).docx`
- *language* `Usama - Backup/Active Transactions/Asian Development Bank/M6/ADB55.1 - Appendix 5 Consent Letter to ADB [AKLA][October 05, 2026].docx`
- *language* `Usama - Backup/Active Transactions/EWPL/EWPL17 - Letter to Chief Secretary [AKLA][Execution Draft][December 03, 2025].docx`
- *language* `Resigned Employees/Tayyaba - Backup/Tayyaba Hyder/D Baluch (LRC)/Drafts/4. Letter to the GoS for Traffic Reduction [AKLA Revised Nov 18, 2025] (clean).docx`

**research_memo** (Hub type: Research Memo)
- **Base** `Usama - Backup/Active Transactions/PTQ/PTQ15.4 - Memorandum - RMC And The Trustee [US AY Final V.3][October 07, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Artistic Milliners/AM45.8 - Memorandum - Key Legal Issues [Final Sent to Boss][September 03, 2026].docx`
- *language* `Ayaan - Backup/AKLA/Assigned/Project Cancer/Memorandums/Final Circulation Versions/Memorandum on Shareholder Deadlock [AKLA][Circulation Version][April 02, 2026].docx`
- *language* `Usama - Backup/Active Transactions/NSCL/Transmission Services Agreement/NSCL5.9 - Concept Paper [Sent to Boss V.2][September 28, 2026] - Clean.docx`
- *skeleton* `Usama - Backup/Active Transactions/Precedents/Memorandums/ZSPL Exit Memo [AKLA Circulated January 14, 2025].docx`
- *skeleton* `Resigned Employees/Fateh - Backup/Active Work/Pakistan Railways/Internal Note On the Animal-PR/[FK] Internal Note on the Legal Status and Organisational Structure of Pakistan Railways for PPP Execution [AKLA Draft] [November 03, 2025].docx`

**services_consultancy** (Hub types: Independent Engineer's Agreement, Independent Auditors' Agreement; framework/agency is new. MM68 is US Legal)
- **Base (framework)** `Usama - Backup/Active Transactions/Master Mining/MM68 - Framework Agreement ML - 31 [AKLA][Revised Final Version][November 04, 2025].docx`
- **Base (IE/IA)** `Areen - Backup/AKLA/MEW Qayyumabad/IE & IA Agreement/4. Draft Circulated to the client/IE Agreement [June 04, 2026].docx`
- *language* `Areen - Backup/AKLA/MEW Qayyumabad/IE & IA Agreement/2. Circulated To NHS/IA Agreement [June 02, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM130 - Investment Agency Agreement A [AKLA][Pre-Exe][July 08, 2026].docx`
- *skeleton* `Areen - Backup/AKLA/SITE/IE Agreement/4. WIP (4) - AR/[AR] IE Agreement [SITE] [February 25, 2026].docx`
- *skeleton* `Ayaan - Backup/AKLA/Unassigned/FINAL FINAL MASTER/ML - 30 Framework Agreement - Schedules [Final Version][October 23, 2025][v2].docx`

**legal_opinion** (Hub type: Legal Opinion)
- **Base** `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM142.2 - T&RA - Legal Opinion [AKLA][Cir Ver][October 07, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Lakeside/Change in Shareholding/LEL127 - Post-Execution Legal Opinion [AKLA][Fully Executed][September 26, 2025].docx`
- *language* `Resigned Employees/Fateh - Backup/Active/Orient/5. Orient Legal Opinion [AKLA - Circulation Version] [October 9, 2025] [v.3][1].docx`
- *language* `Usama - Backup/Active Transactions/NSCL/Arbitration Matter/NSCL8 - Legal Opinion [AKLA][1st Cir][August 04, 2026].docx`
- *skeleton* `Areen - Backup/AKLA/MEW/Service Station Additional Development Right/MEW - Service Station Additional Development Rights - Legal Opinion [October 05, 2026].docx`
- *skeleton* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/3. Retainer Work/5. GoS Shareholding (Land Matter)/Final Draft/EWPL - Opinion on GoS Shareholding In EWPL [Final Draft][May 02, 2025].docx`

**client_proposal_engagement** (Hub type: Client Proposal Letter)
- **Base** `Usama - Backup/Active Transactions/Port Qasim Coal Plant DD/PQE4.3 - Port Qasim Electric Proposal [AKLA][Clean][August 19, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Artistic Milliners/AM7 - Artistic DISCOs Proposal [AKLA][Circulation Version][July 17, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Dhabeji Bid - PIDG/PI12 - Proposal for PIDG [AKLA][Final Execution Version][April 20, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Dhabeji Bid - PIDG/PI45 - Supplementary Proposal [AKLA][4th Circulation][September 15, 2026].docx`
- *skeleton* `Ayaan - Backup/AKLA/Assigned/KPT/Proposals/KPT6 - Proposal for Legal Advisory Services to KPT [AKLA][Third Circulation Draft]][January 21, 2026].docx`
- *skeleton* `Areen - Backup/AKLA/Project Carbon/Proposal/Project Carbon - Fee Proposal [December 03, 2025].docx`
- Note: no firm-authored engagement letter exists; all found are counterparty forms.

**amendment_addendum** (no Hub type)
- **Base** `Usama - Backup/Active Transactions/NSCL/ISPC/ISPC - SPA Amendment Agreement [AKLA][Third Circulated][February 20 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/DHA Dredging/DHA9 - First Amendment Agreement [AKLA][First Draft][January 23, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Lakeside/Change in Shareholding/LEL74 - Share Pledge Amendment Agreement [AKLA][Execution Version][August 13, 2025].docx`
- *language* `Usama - Backup/Active Transactions/EWPL/IA Extension/EWPL4 - IA 2nd Amendment Agreement [AKLA][1st Cir][June 05, 2026].docx`
- *language* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/3. Retainer Work/24. IA&IE Amendment Agreements/IE Amendment/3. EWPL - IE Extension Letter [AKLA Draft Jan 05, 2026].docx`

**escrow_account** (Hub type: Escrow)
- **Base** `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM58 - Escrow Agreement [AKLA][April 26, 2026] - Final.docx`
- *skeleton* `Resigned Employees/Tayyaba - Backup/My Transactions/MEW/4. Retainer Work/5. Escrow Amendment Agreement/May 21, 2025 (final)/MEW - Escrow Amendment Amendment Agreement (clean version) [May 21, 2025] (final execution).docx`
- *language* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/3. Retainer Work/21. Escrow Agreement/6. Escrow Agreement [AKLA Revised Nov 07, 2025].docx`
- *language* `Resigned Employees/Tayyaba - Backup/My Transactions/MEW/4. Retainer Work/5. Escrow Amendment Agreement/May 16, 2025/MEW - Escrow Amendment Agreement [May 16, 2025] v2 (final).docx`

**board_resolution_corporate** (no Hub type)
- **Base** `Areen - Backup/AKLA/MEW Qayyumabad/Documents Sent/Board Resolution Authorizing Lead Member [March 01, 2026].docx`
- *language* `Ayaan - Backup/AKLA/Assigned/Zorlu/CTC of Board Resolution - Novation Agreement [AKLA][Second Draft][April 06, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Scatec/SC75 - Helios - Extract of Resolutions - SOFR transition [AKLA][First Draft][September 15, 2025].docx`
- *language* `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM84 - Form 10 SECP - Letter of Project Assignment [AKLA][First Circulated][May 11, 2026].docx`
- *skeleton* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/3. Retainer Work/14. Change in Articles/Letters & BR/v2/EWPL - Notice of EOGM [Draft][October 03, 2025].docx`
- *skeleton* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/3. Retainer Work/14. Change in Articles/Letters & BR/v2/EWPL - Mints of EOGM [Draft][October 03, 2025].docx`

**certificate_consent** (no Hub type)
- **Base** `Usama - Backup/Active Transactions/Scatec/Tariff Modification Matter/SC12 - ICA Consent Letter [AKLA][2nd Cir][July 20, 2026] - Clean.docx`
- *skeleton* `Areen - Backup/AKLA/SKIM/Financing/SKM CP/Master Certificate/2. Master Certificate of Conditions Precedent [Execution Version].docx`
- *language* `Ayaan - Backup/AKLA/Unassigned/Master Mining/ML-29 - 32/Certificates for validity of ML/2. v.2 ML - 31 Certification (for validity of ML) First Draft [November 3, 2025].docx`
- *language* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/3. Retainer Work/29. Substantial Completion Certificate/Substantial Completion Certificate [AKLA Draft Nov 04, 2025].docx`
- *language* `Usama - Backup/Active Transactions/Master Mining/Mahian & ML - 50 - DD/MM2 - Master Mining NOC - ML - 50 [AKLA][First Draft][February 18, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Pakistan Cricket Board/PCB41 - Certification from Government [AKLA][October 24, 2025].docx`

**meeting_minutes** (Hub types: Meeting Minutes / Transcript)
- **Base** `Usama - Backup/Active Transactions/Artistic Milliners/AM31 - MRC Presentation Meeting Notes [AKLA][August 20, 2026].docx`
- *language* `Usama - Backup/Active Transactions/NSCL/Gas Sale Agreement/NSCL13 - Outcome of the SSGC Meeting [AKLA][September 11, 2026].docx`
- *language* `Ayaan - Backup/AKLA/Unassigned/Orion Exploration/Orion - Siddiqsons Meeting - Notes [AKLA][December 01, 2025].docx`
- *language* `Usama - Backup/Active Transactions/Pakistan Railways PPP/PR52 - Railways HQ Meeting - Notes [AKLA][September 09, 2025].docx`
- *skeleton* `Usama - Backup/Active Transactions/NSCL/Sojitz Term Sheet/NSCL32 - AKLA & NSCL Meeting - June 24, 2026 - Discussion Pointers [AKLA][July 04, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Orient/Pakistan Cable/OES7 - Discussion Points - Financing for PC [AKLA][First Circulated Draft][December 15, 2025].docx`

**concession_agreement** (Hub type with Word standard)
- **Base** `Usama - Backup/Active Transactions/Asian Development Bank/M6/ADB68 - Standard Concession Agreement [AKLA][1st Cir][May 08, 2026].docx` (equals the Hub asset `firm-skills/concession-agreement/assets/Standard Concession Agreement [AKLA].docx` less 1 insertion, 4 deletions and 11 comments)
- *language* `Usama - Backup/Active Transactions/Asian Development Bank/M6/ADB68.24 - Standard CA - M6 Converted [US-UM TP Final V.5][October 17, 2026] - Clean.docx`
- *language* `Usama - Backup/Active Transactions/Rani Bagh/RBP24 - Concession Agreement [Pre-Execution Version][AKLA][[January 17, 2026] - Clean.docx`
- *language* `Areen - Backup/AKLA/Cancer Precision/PIA/6. Second Draft - Circulated [Post Clean Up]/Project Implementation Agreement - PKGenP [AKLA][Second Draft][June 08, 2026] - Clean Version.docx`
- *skeleton* `Usama - Backup/Active Transactions/Peoples Green Transport/PGT6 - Concession Agreement - Execution Version - MEW.docx`
- *skeleton* `Areen - Backup/AKLA/Balochistan Hotel/Balochistan House - Concession Agreement [AKLA Draft] [March 06, 2025].docx`

**rfp_bid_docs** (RFP type exists, id 2179ed80-…, with the KPQC-derived Word standard)
- **Base (Vol I)** `Usama - Backup/Active Transactions/Asian Development Bank/M6/ADB58.7 - M-6 Section I RFP - Volume I [For Team and Boss Rev V.2][October 17, 2026] - Clean.docx`
- **Base (technical proposal)** `Usama - Backup/Active Transactions/Engro Bid/EE9 - Technical Proposal [AKLA][For Hashim Bhai Review][July 03, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Engro Bid/EE3 - Pre-Bid Clarification Document [AKLA][June 29, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Pakistan Cricket Board/PCB36 - Form Tech-2 - Consultant's Organization & Experience [AKLA][September 18, 2025].docx`
- *skeleton* `Usama - Backup/Active Transactions/Asian Development Bank/M6/ADB70.2 - TP-1 RFP - Volume I [KWSC][Issued Version][March 15, 2024].docx`

**security_docs** (no Hub type; two format lineages, owner to choose)
- **Base (Arial lineage)** `Usama - Backup/Active Transactions/AsiaPak - SSRL/Mortgage Matter/AP81 - MODTD [AKLA][For Execution][July 28, 2026] - Clean.docx`
- **Base (Arial lineage, pledge)** `Usama - Backup/Active Transactions/Lakeside/Change in Shareholding/LEL74 - Share Pledge Amendment Agreement [AKLA][Execution Version][August 13, 2025].docx`
- *skeleton (TNR lineage)* `Usama - Backup/Active Transactions/AsiaPak - SSRL/Mortgage Matter/AP82 - Letter of Hypothecation [AKLA][For Execution][July 28, 2026] - Clean.docx`
- *skeleton (TNR lineage)* `Usama - Backup/Active Transactions/AsiaPak - SSRL/Mortgage Matter/AP80 - Mortgage Deed [AKLA][For Execution][July 28, 2026] - Clean.docx`
- *language* `Areen - Backup/AKLA/SKIM/GoP Financial Instrument/6. AK Markup - New Drafts/GoP Guarantee - Operational VGF [AKLA Circulated Aug 26, 2026].docx`

**cta_finance** (Hub types: CTA, Intercreditor, Interfinance, Islamic Finance; bases adopted from lenders' counsel)
- **Base** `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM135 - Musharaka Agreement A [AKLA][Pre-Exe][July 08, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM80 - Musharaka Agreement A [AKLA][First Circulated][May 11, 2026].docx`
- *language* `Areen - Backup/AKLA/SKIM/ICA/1. Intercreditor Agreement [First Circulated][May 19, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Scatec/SC29 - Conventional Working Capital Facility Agreement [AKLA][First Draft][February 20, 2025].docx`
- *skeleton* `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM129 - Inter-Finance Parties Agreement [AKLA][Pre-Exe][July 08, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM139 - CTA [AKLA][Execution Version][October 05, 2026].docx` (a PDF conversion; no clean native CTA exists)

**epc_contract** (Hub types: EPC Contract, Design Agreement)
- **Base (long form)** `Areen - Backup/AKLA/MEW Qayyumabad/EPC Contract/KPQC EPC Contract - Clean [September 12, 2026].docx`
- **Base (firm short form)** `Usama - Backup/Active Transactions/Orient/Pakistan Cable/OES16 - EPC Contract [AKLA][Second Circulated Draft][December 18, 2025] - Clean.docx`
- *language* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/3. Retainer Work/19. EPC Settlement/EWL EPC Related Matters Agreement I [Draft Oct 28, 2025 TT Clean].docx`
- *language* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/3. Retainer Work/20. EPC Side Letter/Drafts/4. EPC Side Letter [AKLA Revised Nov 07, 2025] (clean).docx`
- *skeleton* `Areen - Backup/AKLA/MEW/EPC Contract/MEW - Engineering, Procurement and Construction Agreement  [Execution Version September 09, 2022].docx`

**equity_funding** (Hub type: Equity and Funding Utilization; PTQ5.2 body is Times New Roman 11, the ESSA base is Arial 11 on US Legal)
- **Base (EF&U)** `Usama - Backup/Active Transactions/PTQ/PTQ5.2 - Equity Funding and Utilization [AKLA][[Cir Ver][October 03, 2026].docx`
- **Base (ESSA)** `Resigned Employees/Tayyaba - Backup/Tayyaba Hyder/D Baluch - Ghotki/Equity Subscription And Shareholding Agreement[AKLADraft][Dec 18, 2025].docx`
- *skeleton* `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM95 - MEW - EF&U Agreement [AKLA Execution Draft November 16 2021].docx`
- *language* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/4. Backups/Hammad/Hammad Work/ENERTECH/2. Agreements/EF&U Agreement [Final Draft]/1. Execution Version/EWL-Equity_Funding_and_Utilization_Agreement [Execution Verstion] [December 12, 2023].docx`
- *language* `Resigned Employees/Bharti - Backup/office work/Enertech/Enertech/EWPL - EF&U - Clean.docx`
- *language* `Usama - Backup/Active Transactions/Orion/OR - Equity Subscription and Shareholding Agreement [AKLA][November 10, 2025].docx`

**due_diligence** (Hub type: Due Diligence Report)
- **Base** `Usama - Backup/Active Transactions/Artistic Milliners/Due Diligence/AM1 - Sapphire DD Volume I [AKLA][Final Draft][September 16, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Artistic Milliners/Due Diligence/AM2 - Sapphire DD Volume II [AKLA][Final Draft][September 16, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Artistic Milliners/Due Diligence/AM3 - Sapphire DD Volume III [AKLA][Final Draft][September 16, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Artistic Milliners/Due Diligence/AM5 - Sapphire DD Volume V [AKLA][Final Draft][September 16, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Dhabeji Bid - PIDG/PI28.7 - Draft Due Diligence Report [AKLA][Final Version][May 08, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Master Mining/Mahian & ML - 50 - DD/MM42 - Due Diligence Report [AKLA][Final Circulation Version][April 03, 2026].docx`

**concession_direct_agreement** (Hub type: Concession Direct Agreement; Arial vs Garamond)
- **Base** `Areen - Backup/AKLA/SKIM/Concession Direct Agreement/6. Second Circulated Version/Clean Version - Concession Direct Agreement [SKIM] [June 23. 2026].docx`
- *language* `Areen - Backup/AKLA/SKIM/Concession Direct Agreement/9. AKLA Circulated Draft/SKIM - Concession Direct Agreement [Aug 05, 2026].docx`
- *language* `Areen - Backup/AKLA/KPT/Direct Agreement/DA/15. KGTL DA (Draft)/KGTL - Direct Agreement [June 24, 2026].docx`
- *skeleton* `Areen - Backup/AKLA/KPT/Direct Agreement/DA/14. Final Circulated/KGTML - Direct Agreement [May 18, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Karachi Port Trust/KPT47 - Clean - KGTML-Direct Agreement [AKLA][February 12, 2026] - Colour Coded.docx`

**site_license_lease** (Hub type: Site License; TNR vs Arial)
- **Base** `Usama - Backup/Active Transactions/PTQ/PTQ3.2 - Project Site License Agreement [AKLA][[Cir Ver][October 03, 2026].docx`
- *language* `Resigned Employees/Tayyaba - Backup/Tayyaba Hyder/SITE/License Agreement/Project Site License Agreement [SITE][October 08, 2025] v.3 (Clean).docx`
- *language* `Areen - Backup/AKLA/SITE/Project License Agreement/Clean - Project Site License Agreement [February 13, 2026].docx`
- *language* `Ayaan - Backup/AKLA/Assigned/Chiniot Sargodha/Rental Agreement/WIP2 - Rental Agreement [AKLA][First Draft][April 27, 2026].docx`
- *skeleton* `Resigned Employees/Tayyaba - Backup/My Transactions/MEW/2. Agreement (searchable)/1. Original Execution Versions/1. Project Documents/Project Site License Agreement [Execution Draft January 09, 2021].docx`

**price_escalation** (Hub type: Price Escalation)
- **Base** `Resigned Employees/Bharti - Backup/office work/Malir Expressway/Malir/MEW Documents [Executed Versions]/Pre-Execution Version/Execution Versions/MEW - Price Escalation Agreement [Execution Version] [18.11.21].docx`
- *skeleton* `Usama - Backup/Active Transactions/PTQ/PTQ4 - Price Escalation Agreement [AKLA][September 30, 2026].docx`
- *language* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/4. Backups/AH Backup [December 13, 2024]/Enertec/7. Price Escalation Agreement/V5 [November 18, 2022]/2. EWPL - Draft Price Escalation Agreement [v1] [AKLA Draft] November 17, 2022].docx`

**status_weekly_report** (Hub type: Status Report)
- **Base (inception report)** `Areen - Backup/AKLA/ADB - M6/Inception Report/Past Precedent/1. KBWS Project - Inception Report [AKLA Draft - April 5, 2022] (v1).docx`
- **Base (internal notes)** `Usama - Backup/Active Transactions/AKLA Team General Work/A35 - Mandate Notes - Fateh - November 11 to 19, 2025 - Usama Reviewed [AKLA][November 20, 2025] - Clean.docx`
- **Base (weekly input)** `Usama - Backup/Active Transactions/AKLA Team General Work/A27 - Boss's Input Required - Week Starting November 03, 2025 [AKLA][November 02, 2025].docx`
- *language* `Areen - Backup/AKLA/Work Tracker [July 24, 2026]/September 2026/Week Starting From September 21, 2026/AKLA - Projects - Deliverables & Work Allocation.docx`
- *language* `Resigned Employees/Fateh - Backup/Active Work/Pakistan Railways/Pakistan Railways Bi-Weekly check in [October 29, 2025].docx`
- *skeleton* `Areen - Backup/AKLA/ADB - M6/Inception Report/Past Precedent/URI - Inception Report [AKLA Draft November 23, 2020].docx`

**term_sheet** (no Hub type)
- **Base** `Usama - Backup/Active Transactions/Maxamcorp/FFC & Biafo/MXM38 - Term Sheet for SHA [AKLA][Fifth Circulation Version][January 22, 2026] - Clean.docx`
- *skeleton* `Usama - Backup/Active Transactions/NSCL/NSCL - Term Sheet [AKLA][First Draft][October 29, 2025].docx`
- *skeleton* `Usama - Backup/Active Transactions/Alpha Cement/Alpha Cement Company Limited - Heads of Terms [AKLA WD][July 23, 2025].docx`
- *skeleton* `Usama - Backup/Active Transactions/Asian Development Bank/M6/ADB45.6 - Term Sheet - M6 CA [AKLA][2nd Cir][October 17, 2026] - Clean.docx`
- *language* `Usama - Backup/Active Transactions/NSCL/Sojitz Term Sheet/NSCL7 - Sojitz - Addendum No.2 - Term Sheet [AKLA][Third Sent Draft][February 23, 2026] - Clean.docx`
- *language* `Usama - Backup/Active Transactions/Riali/RI10.6 - Riali Term Sheet [AKLA][1st Cir][September 28, 2026] - Track.docx`

**undertaking** (no Hub type)
- **Base** `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM137 - Sale Undertaking A [AKLA][Pre-Exe][July 08, 2026].docx`
- **Base (purchase side)** `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM78 - Purchase Undertaking A [AKLA][First Circulated][May 11, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM77 - Sale Undertaking A [AKLA][First Circulated][May 11, 2026].docx`
- *language* `Usama - Backup/Active Transactions/AsiaPak - SSRL/Mortgage Matter/AP83 - Mr. Chishty Undertaking [AKLA][Final Circulation][July 29, 2026] - Clean.docx`
- *language* `Usama - Backup/Active Transactions/Boss Internal Matters/B11 - Undertaking for PTM - Boss [October 27, 2025].docx`

**deed** (no Hub type)
- **Base** `Usama - Backup/Active Transactions/SADB/Trust Deed/SADB4 - Deed of Trust [AKLA[Usama WD][July 24, 2026].docx`
- *skeleton* `Resigned Employees/Fateh - Backup/Back Ups/Fateh Khan [August 29, 2025]/Fateh Khan (Old Files)/AKLA FATEH KHAN (1)/Lakeside/Lakeside/Work - Lakeside/Change in Shareholding/Lakeside - Deed of Partial Release - Pakistani Law - Outgoing Shareholder [AKLA Second WD][July 10, 2025].docx`
- *language* `Ayaan - Backup/AKLA/Unassigned/Orion Exploration/RELINQUISHMENT DEED OF PARTNERSHIP SHARE[Absolute Final].docx`
- *language* `Resigned Employees/Tayyaba - Backup/Tayyaba Hyder/Pending Deliverables/April 14, 2025/Gift Deed [AKLA Draft] [April 10, 2025].docx`

**mou** (no Hub type)
- **Base (G2G MOU)** `Usama - Backup/Active Transactions/EWPL/EWPL39 - TP 4 - G2G MOU - EHC and GoS [AKLA][Final Version][December 17, 2025].docx`
- **Base (LOI to government)** `Usama - Backup/Active Transactions/Project Cancer/PC37 - LOI - Ministry of Health [AKLA]Third Sent][February 26, 2026] - Clean.docx`
- **Base (commercial LOI)** `Resigned Employees/Tayyaba - Backup/Tayyaba Hyder/NSCL/LOI Template/LOI Draft Template [August 08, 2025].docx`
- *language* `Usama - Backup/Active Transactions/EWPL/EWPL54 - E-Mobility - G2G MOU - EHC and GoS [AKLA][Working Draft][February 01, 2026] - Clean.docx`
- *skeleton* `Resigned Employees/Fateh - Backup/Active/NSCL/MOU-PS/V2 NSCL & PS - MOU [Draft] [October 27, 2025] - Copy.docx`
- *skeleton* `Resigned Employees/Tayyaba - Backup/My Transactions/Asiapak/1. AsiaPak - Isb International Airport/MoU ISB PPP - RIGA [First Draft][September 24^J 2024] v1.docx`

**jv_shareholders** (no Hub type)
- **Base** `Usama - Backup/Active Transactions/Artistic Milliners/AM29 - Project Keystone-Consortium Agreement [AKLA][Proposed Draft][August 11, 2026].docx`
- **Base (bid JV content)** `Areen - Backup/AKLA/MEW Qayyumabad/7. Amended And Restated Joint Venture Agreement [AKLA][Third Draft][Clean Version][February 21, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Precedents/JVAs/JV Agreement [Execution Draft] [September 16, 2024] v1.docx`
- *skeleton* `Ayaan - Backup/AKLA/Unassigned/Orion Exploration/5._AS_-_JV_Agreement_Draft_[AKLA][First_Draft][November_3,_2025][1].docx`
- *language* `Usama - Backup/Active Transactions/Maxamcorp/Explosives Assignment/MXM3 - Term Sheet For SHA [Last Circulated][January 23, 2026] - Clean.docx`
- *language* `Usama - Backup/Active Transactions/NSCL - Reconstitution of Partnership Deed - NSCL [AKLA][Execution Version][April 30, 2026] - Clean.docx`

**supply_agreement** (no Hub type; one firm-originated lineage, the rest are counterparty forms marked up)
- **Base** `Usama - Backup/Active Transactions/NSCL/Sojitz Term Sheet/NSCL41 - Offtake Agreement [AKLA][1st Cir to Sojitz][July 15, 2026] - Clean.docx`
- *skeleton + language* `Usama - Backup/Active Transactions/NSCL/Gas Sale Agreement/NSCL9.27 - GSA [Final Sent to NSCL to Forward SSGC][September 25, 2026] - Clean.docx`
- *skeleton + language* `Usama - Backup/Active Transactions/EWPL/Fuel Supply Agreement/EWPL6 - Fuel Supply Agreement [AKLA][Final Cir][July 24, 2026] - Clean.docx`
- *skeleton* `Usama - Backup/Active Transactions/NSCL/Power Supply Agreement/NSCL8.4 - Power Supply Agreement [AKLA][Pre-Execution Version][August 24, 2026] - Clean.docx`
- *skeleton* `Usama - Backup/Active Transactions/Orient/Pakistan Cable/OES28 - Offshore Supply Contract [AKLA][Second Draft][January 06, 2026] - Clean for Gemini.docx`

**om_agreement** (no Hub type)
- **Base** `Resigned Employees/Tayyaba - Backup/My Transactions/MEW/4. Retainer Work/16. O&M/MEW - O&M Agreement [AKLA Fourth Draft][Jan 14, 2026] (clean).docx`
- *skeleton* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/4. Backups/AZ backup vs [September 13, 2024]/Aziz AKLA/ENERTECH/0.2 Latest Agreements/2. WP O&M Agreement/EWL-WP O&M Agreement [Execution Version May 03, 2023].docx` (the real file name has non-breaking spaces after "EWL-WP", after "O&M" and before "2023", so copy it from Finder rather than from here)
- *language* `Resigned Employees/Bharti - Backup/office work/Enertech/Enertech/Project Documents/EWL - Warranty Period O&M Agreement [AKLA Execution Draft July 8, 2021].docx`

**power_of_attorney** (no Hub type)
- **Base (bid PoA)** `Areen - Backup/AKLA/MEW Qayyumabad/Bidding/PoA/JN & Co/T3 - Form of Power of Attorney JN & CO. Part A-Rs 1000.docx`
- **Base (bid security PoA)** `Areen - Backup/AKLA/MEW Qayyumabad/Bidding/Bid Security - Authorization Letter/Power Of Attorney For Delivery And Submission Of Bid Security.docx`
- *skeleton* `Areen - Backup/AKLA/MEW Qayyumabad/Bidding/PoA/Lead/T3 - Form of Power of Attorney Part B Lead Member Appointment-Rs 1000.docx`
- *language* `Areen - Backup/AKLA/MEW Qayyumabad/Documents Sent/Authority Letter [March 01, 2026].docx`
- *language* `Usama - Backup/Active Transactions/CDA - Illegal Schemes Bid/CDA - POA - Authorized Representative of the Firm [AKLA][Print Version][March 06, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Pakistan Cricket Board/PCB16 - Power of Attorney [AKLA][August 28, 2025].docx`

**affidavit_declaration** (no Hub type)
- **Base** `Areen - Backup/AKLA/MEW Qayyumabad/Notarized Affidavit/Affidavit.docx`
- **Base** `Ayaan - Backup/AKLA/Assigned/Chiniot Sargodha/Finalized bid docs/Affidavit For Conflict of Interest (Stamp paper and notarized).docx`
- *skeleton* `Ayaan - Backup/AKLA/Assigned/MEW/RFP/Bidding Docs/Seperate Affidavits/AFFIDAVIT - blacklisting (HCS).docx`
- *skeleton* `Resigned Employees/Fateh - Backup/Active/CTBCM/APTMA Precidents/APTMA/14. Intervention Petition/V4 [Circulated]/1. Affidavit [Intervention Petition] [AKLA Draft] [June 21, 2023].docx`
- *language* `Usama - Backup/Active Transactions/Aqua Culture/AQ13 - Confirmation and Declaration [AKLA][January 02, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Scatec/Technical Completion Date Declaration/SC6 - TCD Declaration [AKLA][Second Circulated][April 21, 2026].docx`

**checklist_matrix_list** (no Hub type)
- **Base (risk matrix)** `Usama - Backup/Active Transactions/Waste Project/WP3.7 - ICT SWM RAM [For Boss Review][September 22, 2026] - Clean.docx` (US Letter; the A4 question applies)
- **Base (document-request checklist)** `Usama - Backup/Active Transactions/Master Mining/Mahian & ML - 50 - DD/MM6 - Preliminary Checklist [AKLA][Second Draft][February 20, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/SADB/Trust Deed/SADB8 - Risk Matrix [AKLA][Usama Draft][July 24, 2026].docx`
- *skeleton* `Usama - Backup/Active Transactions/Siaklot Kharian Motorway/SKM47 - Additions Of Conditions Precedent & Conditions Subsequent [AKLA][April 23, 2026].docx`
- *language* `Usama - Backup/Active Transactions/Project Carbon - KPK/PC4 - Bidding Documents Checklist [AKLA][March 17, 2026].docx`
- *language* `Resigned Employees/Tayyaba - Backup/Tayyaba Hyder/internship/DAY 1/Checklist - Federal Procurement Law [AKLA Final] [August 17, 2024] [MHH][1].docx`

**project_doc_other** (no Hub type; agreement schedules belong inside their agreement's pack)
- **Base (internal table)** `Usama - Backup/Active Transactions/NSCL/Gas Sale Agreement/NSCL11 - GSA [AKLA][Schedule of Changes][September 07, 2026].docx`
- *language* `Usama - Backup/Active Transactions/NSCL/Gas Sale Agreement/NSCL17 - Gas Sale Matter File TOC [AKLA][October 01, 2026].docx`
- *language* `Areen - Backup/AKLA/SKIM/CTA/7. Last/Schedule K - Master Certificate [AKLA Draft] [June 18, 2026].docx`
- *language* `Resigned Employees/Tayyaba - Backup/My Transactions/Zorlu/0. Zorlu (Bilal's Backup)/Zorlu EPA/Jan 2024 drafts/Schedule 10 - Measurement Of Certified Degraded Energy.docx`
- *skeleton* `Areen - Backup/AKLA/ADB - Standard CA/CA/9. Finalization Draft/SDCA - ADB - Schedules.docx`
- *skeleton* `Ayaan - Backup/AKLA/Assigned/AMI Metering/Bid Docs/Complete Forms/8. Annexure 2 - Curiculam Vitae - Ali Asgher Khan [AKLA][Circulated Version][March 10, 2026].docx`

**Held or folded elsewhere (no new type recommended now)**
- *share_purchase*: **Base** `Resigned Employees/Hadi - Backup/SPA/Ranipur Mills/ranipur drafts SPA/3. AKLA Circulated Draft/9. RSM SPA [AKLA Final Clean Draft July 13, 2025].docx`; **Base (amendment)** `Usama - Backup/Active Transactions/NSCL/ISPC/ISPC - SPA Amendment Agreement [AKLA][Third Circulated][February 20 2026].docx`; *language* `Usama - Backup/Active Transactions/Master Mining/Mahian - ES&SA/New/AK v13 SSA - Usama.docx`, `Usama - Backup/Active Transactions/Master Mining/MM51 - Original Option Termination Agreement ML - 29 [AKLA][Final Version][October 24, 2025].docx`.
- *litigation_pleading*: **Base** `Resigned Employees/Tayyaba - Backup/My Transactions/Zorlu/0. Zorlu (Bilal's Backup)/Zorlu second modification petition/Zorlu Modification Motion [May 17, 2024] [execution version].docx`; **sub-base** `Resigned Employees/Tayyaba - Backup/Tayyaba Hyder/1. My transactions/Zorlu/3. Expert Determination/Expert Determination Physical File [Zorlu]/C. Zorlu Prior Submissions/3. Statement of Case (with Annexures)/1. Statement of Case - Zorlu Enerji.docx`; *language* `Resigned Employees/Tayyaba - Backup/My Transactions/Zorlu/3. Expert Determination/Zorlu Last Hearing/Order/July 14, 2025/Zorlu - CPPA [Proposed Order][August 05, 2025] (cleaned).docx`; *skeleton* `Usama - Backup/Active Transactions/Scatec/Tariff Modification Matter/SC1 - Tariff Modification Petition - Helios [SC][July 18, 2026].docx`, `Resigned Employees/Fateh - Backup/Active/CTBCM/APTMA Precidents/APTMA/11. Punjab UoSC Petition/3. Petition/V4 [AH Revised]/GoPB Petition (Draft) [May 23, 2023] [AKLA Revised].docx`.
- *nda*: **Base** `Resigned Employees/Fateh - Backup/Back Ups/Fateh Khan [August 29, 2025]/Fateh Khan (Old Files)/AI/Template NDA [Two way][1] Big  O Soft.docx`; *language* `Resigned Employees/Fateh - Backup/Back Ups/Fateh Khan [August 29, 2025]/Fateh Khan (Old Files)/AI/NDA [Two way] (Cicero).docx`, `Areen - Backup/AKLA/TP-4/NDA/3. First Circulation Draft/PAK TP4 NDA KWSC EnerTech [Marked Version] [March 17, 2026].docx`; *skeleton* `Areen - Backup/AKLA/TP-4/NDA/2. First Working Draft/PAK TP4 NDA KWSC EnerTech [Marked Version] [March 17, 2026].docx`.
- *epa_power_purchase*: **Base** NSCL41 (as supply_agreement); *skeleton* `Usama - Backup/Active Transactions/Scatec/SC13 - Helios - EPA Amendment [AKLA][First Draft][January 30, 2025].docx`, `Resigned Employees/Tayyaba - Backup/My Transactions/Zorlu/0. Zorlu (Bilal's Backup)/Zorlu EPA/EPA October 2023 for CPPAG/Zorlu EPA_Main Body Draft [3rd Oct 23]_RE2 - AKLA v2 (numbering fixed).docx`; *language* `Usama - Backup/Active Transactions/Zephyr/ZPL46 - EPA Amendment Agreement [AKLA][Second Draft][September 15, 2025].docx`, `Resigned Employees/Tayyaba - Backup/My Transactions/Zorlu/0. Zorlu (Bilal's Backup)/Zorlu EPA/Jan 2024 drafts/Zorlu - Sch X- EPA - Measurement Of Certified Degraded Energy January 08 2024.docx`.
- *track_access*: **Base** `Usama - Backup/Active Transactions/Pakistan Railways PPP/PR71 - Summary of Findings - Track Access Agreement [AKLA][First Draft][September 12, 2025].docx`; *language* `Resigned Employees/Fateh - Backup/Back Ups/Fateh Khan [August 29, 2025]/Active/Pakistan Railways PPP/AKLA Documents/Research Note On The Track Access Policy-Regime [August 28, 2025] - Final.docx`, `Usama - Backup/Active Transactions/Pakistan Railways PPP/PR170 - TAA & RDA  Flowchart [AKLA][First Draft][March 20, 2026].docx`; *skeleton* `Usama - Backup/Active Transactions/Pakistan Railways PPP/PR41 - Track Access Agreement - RDMC [PR][First Draft][September 08, 2025].docx` (counterparty).
- *policy_regulatory_drafting*: **Base** `Usama - Backup/Active Transactions/Pakistan Railways PPP/PR159  - PPP Framework Report [AKLA][Second Circulated Draft][March 15, 2026].docx`; *skeleton* `Usama - Backup/Active Transactions/Pakistan Railways PPP/PR160 - PPP Toolkit [AKLA][Second Circulated Draft][March 15, 2026].docx`, `Resigned Employees/Tayyaba - Backup/Tayyaba Hyder/Hyderabad BRTS/Concession Framework/2. Concession Framework [April 28, 2025].docx`, `Resigned Employees/Tayyaba - Backup/Tayyaba Hyder/Punjab PPP Assignment/Precedents/Federal/Phase II/New Act/15. AKLA Revised Draft/Federal PPP Act Amedment [Revised Clean Draft March 26, 2020].docx`; *language* `Resigned Employees/Fateh - Backup/Pakistan Railways PPP November 17, 2025/ADB Docs AH/ADB/1. USP Policy/4. Circulated Files/1. Draft of the USP Policy [Federal P3A Project] [AKLA Draft] [August 09, 2023].docx`.
- *template_master*: **Base** `Usama - Backup/Active Transactions/Standard Templates/ST1 - Standard Template for Interview Invitation [AKLA][Final Version][November 07, 2025].docx`; **Base (standing instructions)** `Resigned Employees/Tayyaba - Backup/My Transactions/MEW/5. Backups from drives/AZ Backup [October 31, 2024]/MEW/10. Change of Scope of Order/2. Standing Instructions/6. Standing Instructions Additional Cost Account [MEW] [February 22, 2024] [Draft shared by AH].docx`; *language* `Resigned Employees/Tayyaba - Backup/My Transactions/EWPL/4. Backups/AH Backup [December 13, 2024]/Enertec/28. Letters/19. Mezz SBLC Alternate Arrangements/EWPL - Standing Instructions to MBL [January 24, 2023].docx`, `Areen - Backup/AKLA/AquaCulture/Checklist For Bidding/Documents To Be Sumbitted/Past Precedents/PCB38 - Clarification Regarding Audited Accounts [AKLA][September 22, 2025].docx`; *skeleton* `Resigned Employees/Bharti - Backup/office work/Alpha Cement/Template Head For Agreements - Detailed Version.docx`.

### B. Layout differences between family bases (why one renderer cannot work)

| Base | Page | Margins (T/B/L/R) | Body font, how applied | Main numbering |
| --- | --- | --- | --- | --- |
| Concession Agreement ADB68 | A4 | 3.81/3.81/3.05/3.05 cm | Arial 11 set on every run; Normal = Times New Roman | Heading1 "%1." / Heading2 "%1.%2" / "%1.%2.%3"; 284 list definitions |
| Amendment ISPC | A4 (Legal in DHA9, EWPL4) | 2.5/2.54/2.54/2.54 cm | Arial 11 per run over a TNR Normal | ListParagraph "%1." |
| Escrow SKM58 | A4 | 2.54 all | Arial 11 per run over a TNR Normal | "%1." bold article headings |
| Direct agreement SKIM | US Legal | 3.17/3.17/2.54/2.54 cm | Arial 11 per run (KPT line: Garamond 12) | multilevel |
| Price escalation MEW | US Legal | 3.05 all | Arial 11 per run over a TNR 12 Normal | "%1" Heading1, "%1.%2" bold small caps |
| Site licence PTQ3.2 | US Legal | 3.81/3.81/3.05/3.05 cm | TNR 11 in PTQ3.2; Arial 11 in SITE and MEW | "%1." 13pt bold small caps |
| SPA RSM | US Legal | 2.54/3.0/2.54/2.54 cm | Times New Roman 11 per run | "%1" Heading1 with bottom rule |
| O&M MEW | US Legal | — | Arial 11 per run; inherited style clutter | "%1." Heading1 bold small caps |
| Research memo PTQ15.4 | A4 (landscape annexure section) | 2.54 all | Arial per run; Normal TNR | "%1." bold; navy cover title box |
| Legal opinion SKM142.2 | A4 | 5.08/2.54/2.54/2.54 cm (letterhead) | Arial 11 by default font | "%1." bold section headings |
| Proposal PQE4.3 | A4 | 1.88/3.02/2.54/2.54 cm | Arial 11 per run | "%1." / "%1.%2.", one list per section |
| Meeting notes AM31 | A4 | 2.54 all, header 0 | Arial 11 by default font | "%1." |
| Board resolution | A4 | 2.54 all | Arial 11 default, NormalWeb overridden | "(a)" sub-powers |
| DD Volume AM1 | A4 landscape (portrait since Sep 2026) | 3.32/2.26/2.0/2.0 cm | Arial 11 | "%1." bold small caps underlined |
| Term sheet MXM38 | A4 | 2.54 all | Arial | two-column terms table, "%1." in column 1 |
| Letter EWPL20 | A4 | 2.54/3.0/2.54/2.54 cm | Arial 11, default font and per run | unnumbered body; Ref / Dated / To / Subject lines |
| Framework MM68 | US Legal | 2.54 all | Arial 11 per run over Word's default theme font (Aptos); about 10% of text is 12pt | multilevel |
| EF&U PTQ5.2 | A4 | 3.81/2.50/3.05/3.05 cm | **Times New Roman 11** (TNR 12 Normal, 11 set per run) | "%1." 13pt bold small caps / "%1.%2" / "%1.%2.%3" |
| CTA SKM135 | US Legal | 3.81/3.81/3.05/3.05 cm | Arial 11 per run | multilevel |
| EPC KPQC | US Legal, 2 sections | 2.54 all (body bottom 4.5 cm for the initials footer) | Arial 11 per run over TNR | multilevel |
| Security AP81 | US Legal | 3.05 all | Arial 11 per run over a TNR Normal | — |
| Undertaking SKM137 | US Legal | 2.54 all | Arial 11 per run over a TNR Normal | — |
| G2G MOU EWPL39 | **US Letter** | 2.54 all | **Times New Roman 12.5** per run | typed "N.M" numbers, not Word lists |
| PoA T3 (bid form) | US Legal | 2.54 all | the RFP form's own theme font (Aptos 11) | none |

Each row was re-checked by opening the base on 19 October. The second pass read page size, margins and the font each character actually ends up in, after styles and defaults are resolved. The results are in the scratchpad (`drafting-study/critic/bases.json`, `effont.json`).

Firm-wide constants across bases: Arial 11 justified; Title Case headings in bold small caps; navy 002060 / gold FFC000 tables; bold defined terms without quotes; `[●]`; "Page X of Y". These go in the firm-wide style sheet. Everything in the table above goes in the family's fingerprint.

### C. Format fingerprint and gate

New `chat-service/formatFingerprint.js`:
- `fingerprint(bytes)` returns:
  - `{ sections: [{ pgSz, pgMar, orient, titlePg, headerRefs, footerRefs }] }`;
  - `parts: { styles, numbering, theme, fontTable, headers: {name: sha256}, footers }`, where each value is the sha256 of the part's normalised XML;
  - `headingStyles: {1: styleId, 2: …}`;
  - `body: { font, sizeHalfPts, share }`, measured over the characters of non-empty body paragraphs;
  - `tableStyles`, `placeholder`, `numIds`.
- Stored as `document_type_templates.fingerprint jsonb` and `document_template_versions.fingerprint jsonb` (one migration).

`docxChecks.js formatGate(outParts, packParts, fp)` extends `compareFormat` (docxChecks.js:24-43):
- styles, theme and fontTable must be byte-equal after normalisation. docxAgent never writes these parts, so on its own path this is a tripwire for the redline-js fallback and the pack builder rather than a likely failure;
- numbering may only gain `w:num` entries whose `abstractNumId` already exists, plus `lvlOverride/startOverride`;
- sectPr must be equal (the same count, in the same order). This is what catches the copied-section-break fault (D) and a `remove_block` that swallows a section's closing paragraph;
- header and footer parts must be equal, except for runs inside paragraphs listed as `fp.variableHeaderParagraphs` (title, date line, footer initials row);
- every rPr and pPr in the output must exist in the pack, compared after `clean` and after also stripping `w14:paraId`/`w14:textId` and the `<w:b/><w:bCs/>` pair that `runsFor` adds for a **defined term**. Without this normalisation, today's `compareFormat` already flags every bold defined term and every `#` heading insert (whose pPr is a bare `<w:pStyle/>`) as a novel format, so a refusing gate would refuse ordinary fills;
- as built in slice 1 (19 Oct): every paragraph's fonts and sizes must be ones the pack uses for paragraphs of the same kind (same pStyle, same table context); the whole-document font and size shares are reported as notes, not refusals, because a share rule let a few wrong paragraphs through on long files and refused short ones;
- there must be no typed clause-number prefixes (proofCheck "numbering" rule).

It returns `{ status: 'matches' | 'drift', base: fileName, findings: [plain sentence] }`. Header and footer lines that hold a blank or a date are variable by default. Slice 1 result on the server (19 Oct): both live standards match themselves; a fill of every blank, plus an added clause, heading and comment, matches; a full Concession Agreement fill takes 7.6 s on the VM (RFP Volume I 1.5 s). On the Hub fill path, drift blocks the write in the `applyDocxOps` → `acceptChangesBy` → store sequence (server.js around 2765-2830). It also blocks the guide path's first save (1518-1546) and `writes.saveVersion` in `fillStandardWrite.js` (312-340). The Hub edit path also runs it, against the version being edited.

### D. Engine changes in docxAgent.js

What `applyDocxOps` (lines 673-704) carries byte for byte, as read on 19 October: it rewrites only the story parts (`document.xml`, headers, footers, footnotes, endnotes), plus `comments.xml`, `[Content_Types].xml` and `document.xml.rels` when it adds the first comment. `styles.xml`, `numbering.xml`, `theme1.xml`, `fontTable.xml`, `settings.xml` and every other part are unzipped and re-zipped unchanged, so their bytes are identical even though the .docx container's bytes are not. That holds only on the inline path. A paragraph sent to the redline-js fallback re-serialises `document.xml`, and that library carries its own numbering-part plumbing. Untouched paragraphs keep their XML exactly. Inserted paragraphs copy the anchor's whole `w:pPr` (including any `w:sectPr` in it), and replaced text copies the run properties of the text around it.

- **Heading inserts inherit formatting.** `insertAfter` (around lines 566-579) sets `pPr` to a bare `<w:pStyle/>` and `baseRPr = ""` for "#" headings, so where Arial is set per run over a TNR/Calibri Normal the new heading renders in the wrong font, and its pPr fails the gate. Copy the whole pPr and the first run's rPr from the nearest existing paragraph with the same heading style, with a fallback to the anchor's rPr minus bold.
- **Do not copy section breaks.** `insertAfter` (and `repeat_block`) must strip `w:sectPr` (and any `w:pPrChange`) from the copied pPr. `remove_block` must move a deleted paragraph's `w:sectPr` onto the paragraph before the block, so the section survives acceptance. Bases with in-paragraph section breaks: RFP Vol I (6), O&M (7), price escalation (2), EPC (1), DD (1).
- **New ops**, each validated by `expected` text like the existing ops:
  - `{"op":"write","after":p,"expected":…,"blocks":[{"kind":"h1","text":…},{"kind":"body","text":…},{"kind":"limb","text":…},{"kind":"footnote","on":-1,"text":…},{"kind":"table","like":"issues_register","rows":[[…]]}]}`. Every `kind` is a key of the pack's `kinds.json` (see G). Each holds the exact pPr and the first run's rPr of the firm's example paragraph, plus its `numId`/`ilvl`. Blocks are written in order after ¶p. The first list block after a non-list block gets a new `w:num` on the same `abstractNumId` with `startOverride 1`, which the gate allows. A footnote block appends to `footnotes.xml`, copying the example footnote's pPr/rPr, and puts a reference run after the preceding block's text. This is the only op that writes into a shell pack's body, and the normal way to write a new clause into a form pack;
  - `{"op":"repeat_block","from":a,"to":b,"after":p}` clones the body-level elements (paragraphs and whole tables) spanning ¶a-¶b as tracked insertions. A range that cuts through a table is refused. Clones get fresh `wp:docPr` ids, bookmark ids and `w14:paraId`s, and comment anchors are dropped;
  - `{"op":"add_row","table":t,"like_row":r,"cells":[…]}` copies the row's trPr and tcPr;
  - `{"op":"remove_block","from":a,"to":b}` is a tracked deletion of a whole optional section.
- Extend `OPS_PROTOCOL` (lines 36-55) with these four ops, and lift its ban on footnotes for the `footnote` kind only (comments stay the place for remarks to the reader).
- **Contents page.** After any op that adds or removes a heading, set `w:dirty="true"` on the TOC field's `fldChar` begin. Word then rebuilds the contents on opening. The gate ignores this attribute.
- **Shapes.** Paragraphs holding `mc:AlternateContent`/`w:txbxContent` are refused ("formatting") today. 23 of the 39 bases have them, mostly signature-page lines and cover boxes. The pack builder reports them per pack, so none sits in a slot that must be filled.
- Long files: cache `inspectDocx` results by sha256 for 20 minutes, as fillStandard.js already does. The listing shows headings, `[●]` slots and the clause-list anchors only, paged by `from`.

### E. Style sheet, clause bank, wording check

- `document_types.style_sheet jsonb` holds `{ core: true, voice, spelling, defined_term: {form: 'bold-parenthesis-no-quotes', pointer_formula}, numbers, money, dates, placeholder, cross_ref, formulae: {preamble, parties_close, recitals_open, witnesseth, execution}, banned: [regex + reason], tells_of_counterparty: […] }`.
- `firmRules.js` gains `FIRM_STYLE_CORE` and `styleSheetText(type)`. They are injected next to `FILL_INSTRUCTIONS` (firmRules.js:38) and in connector `get_firm_rules` (connector/tools/firmRules.js:43-48).
- Seeds come from `profiles/<family>.md` §Language, `firm-skills/concession-agreement/references/house-style.md` and `firm-skills/akla-dd-format/references/house-style.md`.
- **Clause bank.** Precedent passages already keep their heading path and clause number (indexing/chunk.js:1-22). Add `family` and `heading_norm` to `precedent_passages` (one migration) and a lookup `clauseExamples(typeId, heading, k=3)` that matches on the normalised heading first, then on the clause-list synonyms. It makes no embedding call. It is used per clause in the fill prompt (examples capped at 2,000 chars each on docx turns, as server.js:2440) and exposed as the connector tool `get_clause_examples`.
- **Wording check.** New proofCheck.js rules: `defined_term_form`, `number_words` (exists; extended to money and dates), `date_format`, `placeholder_style`, `cross_ref_heading`, `spelling_convention`, `banned_phrase`. The output is AKLA comments through the existing comment op, plus a summary line. These rules never block filing.

### F. Clause list, decisions, completeness

- `document_types.skeleton jsonb` holds `[{ id, heading, level, presence: 'always'|'optional'|'decision', decision?: id, examples_heading, not_used_form?: 'Not Used' }]`.
- `document_types.decisions jsonb` uses the shape of questionnaire.js entries (question, options, location, appliesWhen, auto). `questionnaire.js` keeps its engine (`startQuestionnaire`, `advance`, `answerInstruction` 491-511) and reads the decisions from the type row. `RFP_FEDERAL_PPP` (21-424) moves to a seed migration. The Concession Agreement decisions are seeded from `firm-skills/concession-agreement/references/fill-map.md` (10 choices, 11 optional parts, 17 stubs, 4 directives) and `known-issues.md`.
- Skeleton items take an optional `match: 'heading' | 'slot'`. A `slot` item is a fixed paragraph of a shell pack (Ref, Dated, To, Subject, salutation, closing, signature), identified by its `kinds.json` kind and its position, because letters and certificates have no headings to match.
- **Completeness check** (new `skeletonCheck.js`): map the output's heading paragraphs (and, for shells, its slot paragraphs) to skeleton ids, then report missing *always* items, items out of order, and optional items that are neither present nor marked "Not Used". A missing *always* item blocks filing unless the lawyer confirms. The check runs in the Hub after each fill turn and in `fill_standard_to_project`.
- **New clause rule.** This text goes into the fill instructions and the connector note. An inserted heading that matches no skeleton id must carry a comment beginning "New clause — not in the firm's precedents:". The completeness check lists such headings, and a missing comment is added automatically.

### G. Pack builder

`scripts/drafting-packs/build_pack.py` runs with `python3 -I` on a copy that an admin downloads or uploads. It never runs on the OneDrive folder. It:
1. accepts all revisions and removes comments;
2. reports any remaining w:ins/w:del, so the inventory flag is not relied on;
3. for a form pack, lists candidate deal facts (party names, CNICs, addresses, dates, amounts, project names) for `[●]` replacement, written through the same tracked-change engine and then accepted;
4. for a shell pack, takes a list of the furniture paragraphs to keep and one example paragraph per kind (chosen by the reviewer from the base's listing). It deletes the rest of the body through the same engine, accepts the deletion, and replaces the kept examples' text with `[●]`;
5. writes `kinds.json` (kind → `{pPr, rPr, numId, ilvl, styleId}` copied from the example paragraphs, plus table kinds → `{tblPr, header trPr/tcPr/rPr, body trPr/tcPr/rPr}` and the example footnote) for both forms. For a form pack, the kinds come from existing clauses;
6. reports paragraphs with shapes or text boxes, sections, and the TOC field;
7. writes `<family>-pack.docx`, `kinds.json` and `fingerprint.json`.

A person reviews the pack, and it is uploaded through the existing admin "Word standard" flow (`useDocumentTypeTemplates.ts`; bucket `precedent-library`). The family's chosen precedents are uploaded unblanked to the precedent library under the type, so the clause bank and retrieval can use them.

### H. Migrations

1. `document_types`: add `style_sheet jsonb`, `skeleton jsonb`, `decisions jsonb`. Keep `questionnaire text` for one release.
2. `document_type_templates` and `document_template_versions`: add `fingerprint jsonb` and `kinds jsonb`.
3. `precedent_passages`: add `family text`, `heading_norm text`, with an index on `(document_type_id, heading_norm)`.
4. Insert the wave-1 types: Letter / Notice; Framework / Agency Agreement; Amendment Agreement; Board Resolution; Certificate / Consent / NOC. "Independent Engineer's Agreement" and "Independent Auditors' Agreement" already exist (20260820061242:21,30) and only get packs. Research memo packs also serve "Concept Note" (20260919113000, not yet committed). Insert the wave-2 types after the owner's decisions.

Before writing these, run `scratchpad/drafting-study/db/q1-document-types.sql`, `q2-standards.sql` and `q3-skills-and-precedents.sql` (written 19 October, read-only) to confirm the live rows. They were not readable during the study.

### I. Code that changes or retires

- `server.js` 2525-2552 (free draft without a Word standard): for a type with a pack, route to the fill path (2521-2523) with the style sheet, clause list and examples. Remove the untrue sentence at 2530-2534 ("exported inside that file").
- `server.js` 937 `persistReply`: stop house-rendering `<artifact>` blocks that are documents of a type with a pack.
- `server.js` 2553-2570 (edit of a text version, rewritten and house-rendered): convert to Word once and edit through docxAgent, as the simplification review proposes.
- Retire `src/lib/firmDocx.ts` and the export path in `src/lib/templateDocx.ts` (ArtifactPanel.tsx:189-202). Keep `analyseTemplate` only until the fingerprint replaces `format_rules`.
- `aklaRender.js checkAklaFormat` stays for notes and is labelled "general house layout".
- Connector: `standards.js` (`list_document_types`, `read_standard`, `get_drafting_decisions` read the new columns), `fillStandard.js` (listing includes clause-list anchors), `fillStandardWrite.js` (new ops; gate, wording check and completeness check before `saveVersion`), `saves.js` (redirect documents of pack types), new `tools/clauses.js` (`get_clause_examples`). Add new root modules to both lists in deploy.sh (lines 26 and 47).

### J. Effort by slice

| Slice | Pieces | Days |
| --- | --- | --- |
| 1 | formatFingerprint.js, formatGate with the rPr/pPr normalisation, wiring on the Hub fill and edit paths and in fillStandardWrite.js, heading-format and section-break fixes, remove the untrue sentence, time a full Concession Agreement fill on the server, tests | 5 |
| 2 | build_pack.py with form and shell modes and kinds.json (1.5); the `write` op with list restarts, footnotes and table kinds (2); `repeat_block`, `add_row`, `remove_block` with id renumbering and section handling (1.5); 11 wave-1 packs (IE and IA separately) at about 0.4 day each with review (4.5); migrations 2 and 4; free-draft route to the fill path; persistReply change; retire the website exports (1.5) | 11 |
| 3 | style sheets (core plus 12 families), migration 3, clause bank lookup, prompt wiring, wording-check rules | 5 |
| 4 | skeletons (heading and slot items) and decisions for 12 families, questionnaire data move, skeletonCheck.js, new-clause rule, migration 1 | 6 |
| 5 | connector tools: four new ops in fill_standard_to_project, new columns in standards.js, get_clause_examples, saves.js redirect, deploy.sh lists, tests | 3 |
| 6 | wave 2, 20 kinds: pack, kinds, style-sheet differences, clause list and decisions per kind. About 1 day for each of 11 long agreements, 0.5 day for each of 9 short forms | 15 |

The earlier draft of this plan said 31 days. That figure gave wave 2 about 0.4 day per kind for pack, style sheet, clause list and decisions together, and counted 14 wave-2 kinds where the table lists 20. It also had no way to write the body of a letter or memo.
