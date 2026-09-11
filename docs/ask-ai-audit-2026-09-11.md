# Ask AI audit — 11 September 2026

The existing system is a useful foundation, but does not yet establish that a generated document is complete, follows the firm's standard, or has been checked against all applicable current law. The strongest existing design choice is editing a copy of the actual standard DOCX with tracked changes. Keep that approach and add explicit document state, research orchestration, and validation around it.

Scope: local source review of the project AI workspace, Node chat service, Word editing/export, review functions, ingestion, statute resolution, law monitor, and relevant migrations. This was not an authenticated production exercise. The deployed configuration, current database policies, actual uploaded canonical standards, provider availability, and legal quality of live outputs were not verified. Local sample files are not evidence of which standard is currently approved. No application implementation was changed.

## Existing capabilities worth keeping

- Project-scoped conversations, streaming, attachments, history, skills, artifact panels, and saving drafts to project documents.
- Retrieval from project documents, firm precedents, and the law library, with source summaries attached to replies.
- Native DOCX drafting from a standard and iterative edits, with tracked changes and explicit reporting of skipped operations.
- Separate legal, formatting, and conflict review prompts.
- A statute resolver that downloads real source documents, plus a scheduled law monitor that distinguishes amendments from consolidated replacements and archives replaced text.

## Priority findings

### 1. Critical: failed verification can look like a clean review

Evidence: `supabase/functions/suggest-redline/index.ts:107–130` gives each pass 4,096 output tokens, does not check the provider's stop reason, and converts JSON parsing failures into `[]`. It also accepts an unexpected non-array result as `[]`. A malformed or truncated response is therefore indistinguishable from a successful pass that found no issues. The subsequent run deletes prior pending suggestions and can return zero new suggestions. Separately, `chat-service/server.js:688` silently ignores a non-success HTTP response from the instruction-specific review call.

Fix: persist a review run with per-pass states: pending, running, passed, findings, insufficient evidence, failed. Validate structured responses and stop reasons. Retry bounded failures; preserve prior results until a new run successfully commits. Never describe an unexecuted or failed pass as clean. Record instruction-specific checks as a separate required result.

Acceptance: forced malformed JSON, provider truncation, HTTP errors, and unavailable retrieval all produce an explicit incomplete/failed review, never a clean outcome.

### 2. Critical: a review artifact can open the wrong version

Evidence: chat stores `documentVersionId` in the review artifact, but `src/components/ai/chat/ArtifactPanel.tsx:64–75` passes only the matter document ID into `ReviewSession`. `src/components/ai/ReviewSession.tsx:155` loads the latest version. Reviewing v1 while v2 exists can produce a v1 summary beside a v2 review panel. A later upload can also change what an old review opens.

Fix: pin the exact document version, file hash, and review run ID throughout generation, display, acceptance/rejection, preview, download, and saving. Display a stale-review notice when a newer document version exists. Historical review artifacts must remain historical snapshots; currently rerunning also replaces pending suggestions associated with that version.

Acceptance: review v1, upload v2, reopen the old artifact: it still displays v1 and the original run's findings.

### 3. High: formatting review cannot inspect actual formatting

Evidence: `suggest-redline/index.ts:217–238` extracts plain text and fetches only the standard's `content_html`, which now holds extracted plain text. The formatting pass then asks the model to assess formatting, including bold and italics. It cannot establish margins, font properties, paragraph spacing, header/footer layout, or actual Word numbering from that input. The standard's `format_rules` are not supplied to this path either.

Fix: compile each approved standard into a machine-readable profile: section/page setup, paragraph and run styles, numbering definitions, table styles, required clauses, execution blocks, placeholders, and permitted variants. Compare the generated DOCX against that profile in code. Use a model for linguistic house style and substantive structure. A document being parseable does not establish firm compliance.

Acceptance: deliberately change a margin, font, numbering level, header, table style, and required execution block; each supported discrepancy is detected with an exact location and repair or exception.

### 4. High: standard fidelity depends on which route generated the document

Evidence: `chat-service/server.js:480–548` correctly starts DOCX drafts from the real standard. Other routes generate Markdown. `src/components/ai/chat/ArtifactPanel.tsx:111–130` silently falls back to the generic firm exporter if standard export fails. The panel can still show “Formatted as the firm's standard” based merely on a standard filename. `src/lib/templateDocx.ts:484–498` rebuilds the body and keeps only the first section-properties match. Its node renderer has no table case. `RichTextEditor` uses StarterKit alone, without a table extension.

Implications: arbitrary drafting in Ask or custom skills does not automatically select a standard. Markdown export cannot preserve a complex standard's complete body layout, tables, or multiple sections. A DOCX edit preserves the document it started with; that does not make a nonstandard source compliant with the firm's standard.

Fix: resolve document type and an immutable approved template version before drafting. Distinguish “preserve this document's layout” from “standardize this document.” Require supported native DOCX operations for faithful output; expose unsupported layouts or missing standards explicitly. A failed standard export must not silently claim compliance. Let users save unfinished working drafts, but reserve a verified/ready status for documents that pass checks.

### 5. High: DOCX editing lacks comprehensive structural validation

Evidence: `chat-service/docxAgent.js` inspects and edits `word/document.xml` only. Headers, footers, and footnotes are preserved as separate parts, but are not read or updated by the model. Rewritten paragraphs are emitted as `<w:p>` without their original attributes (`:416`). The fallback uses `validate: false` (`:563`); the fast path has no package validation. The separate review redline function does perform a limited redline validation, so this gap is specifically in the chat editing path.

A local synthetic XML/ZIP exercise confirmed: a simple replacement produced the expected accepted text, preserved an untouched clause and header bytes, but dropped the edited paragraph's `w14:paraId`. A placeholder in the header was absent from the model's listing. This demonstrates concrete limitations, not a finding that all generated DOCX files are corrupt.

Fix: preserve node attributes, introduce stable structural targets with expected-text and base-hash preconditions, and support document parts explicitly. Validate the resulting package, relationships, numbering, tables, and tracked-change structure. Add rendered comparisons in a fixed Word-compatible environment for layout-sensitive cases. Microsoft's [Open XML validation documentation](https://learn.microsoft.com/en-us/office/open-xml/word/how-to-validate-a-word-processing-document) provides an established schema-validation mechanism; it still needs firm-specific rules and visual checks.

### 6. High: automatic applicable-law research is not wired into Ask AI

Evidence: `chat-service/server.js:750–790` performs embedding retrieval only. It has no web research tool loop. `supabase/functions/process-document/index.ts:12–76` scans only the first 6,000 characters for explicitly mentioned Acts and marks unavailable ones `needs_upload`. It does not infer all potentially applicable law from project facts or automatically fetch missing laws. The resolver is available through a separate manual workflow. The scheduled monitor updates known laws and selected authorities; it is not a project-specific research planner.

Fix: add a durable research job triggered by project intake, material fact changes, and relevant chat requests. Build a project profile containing jurisdiction/province, sector, parties and entity types, transaction structure, project stage, and relevant date. Identify legal issues, search authoritative sources, download and extract documents, validate identity/status, index them, then retrieve by individual issue. Include delegated legislation, notifications, regulator instruments, and judgments where relevant—not just Acts.

Show discovered candidates separately from confirmed applicable authorities. Record why each source is relevant and what remains unresearched. Ask targeted questions when jurisdiction or transaction facts are missing. Do not promise exhaustive discovery merely because a search completed.

### 7. High: principal-Act filtering can exclude its amendments

Evidence: `law-monitor/monitor.py:497–515` stores an amendment under its own `act_name` and links it using `metadata.amends_act`. Chat and the shared retrieval helper filter by the matter's available Act names. `supabase/migrations/20260912090200_match_documents_iterative_scan.sql:73` checks only `metadata->>'act_name'`; it does not expand `amends_act` relationships.

Implication: an amendment can be ingested correctly but absent from an answer about the principal Act. This is a deterministic retrieval gap whenever the filter contains the principal Act alone.

Fix: introduce stable authority IDs and relationships for amendments, commencement, repeal, subordinate instruments, and consolidations. Retrieve the principal text with applicable linked instruments as of the requested date. Preserve historical snapshots so advice about past transactions is reproducible.

Acceptance: link only a principal Act to a test matter, ingest a relevant amendment separately, and confirm that research and Verify retrieve both with correct dates.

### 8. High: source authenticity and citation support are not consistently enforced

Evidence: `_shared/statuteResolver.ts:94–167` accepts a model-returned PDF URL and title, fetches the URL, and accepts extracted text above a 20-character threshold. The official-source preference is prompt text rather than a hard domain/identity gate. Its direct title matcher ignores numeric year identity. The monitor is stronger, but `monitor.py:246–263` validates the initial host and follows redirects without checking the destination host. Chat asks for `[Source n]` citations but does not validate whether a cited passage supports each claim or provide a structured claim/evidence record.

Fix: share one hardened fetch/verification pipeline across resolver and monitor: validate host and redirects, reject private-network targets, bound file size/time, check file type, authority title/year/jurisdiction, enactment status, and source quality. Store source URL, fetched date, publication/effective dates where established, section/page locators, content hash, and extracted quotation. Validate citation IDs and legal-claim support separately from generation. Label unresolved claims explicitly.

Pakistan Code itself [directs users to original Gazette notifications where doubt exists](https://www.pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2JxbpY%3D-sg-jjjjjjjjjjjjj). A downloaded PDF should not automatically be presented as verified current law.

### 9. High: coverage and conversation state are too implicit

Evidence: chat keeps 30 messages, clips each attachment to 60,000 characters, and uses up to four statute matches per question. Review retrieval embeds only the first 8,000 characters and retrieves three statute excerpts for the entire document. Review prompts request at most eight findings per pass. Long DOCX listings omit paragraphs; the model is told to ask for missing sections but has no actual read-more tool. For Markdown drafts, prior artifact markers become generic placeholders in history; the normal draft branch does not reload a prior Markdown draft's full content as its current base.

Implications: later clauses and earlier deal instructions can be missed. A second-turn Markdown revision can regenerate from incomplete state. A low finding count cannot be treated as exhaustive review. Attachment character budgeting also double-counts current attachments and does not strictly cap their combined inclusion.

Fix: maintain a structured matter fact ledger and explicit active artifact/version independent of chat history. Retrieve by clause and legal issue using both exact citation/keyword matching and semantic search, with surrounding sections. Add document-reading tools and a coverage ledger. Iterate until all required clauses and checks are covered or reported incomplete. Persist missing facts and unresolved placeholders as structured items, including repeated occurrences across parts.

### 10. High: matter/document binding and save consistency need stronger checks

Evidence: `chat-service/server.js:443` loads a supplied thread ID without constraining it to the supplied matter ID; edit version IDs are similarly not checked against that matter. The inspected RLS migrations permit firm-wide access, so membership alone does not prevent one accessible project's context being mixed into another project's conversation. This is a binding/integrity finding, not proof of an unauthenticated data leak.

`src/lib/saveDraftToMatter.ts` selects the first existing document of a type if no document ID was supplied, and allocates a version with `count + 1`. Multiple documents of the same type, deleted versions, or concurrent saves can produce wrong-document selection or collisions. Upload, version insertion, and ingestion are separate steps; failed ingestion is only logged.

Fix: validate all thread, version, artifact, and attachment relationships server-side. Explicitly select create-new versus save-new-version. Allocate versions transactionally, use idempotency keys and expected-base-version checks, and expose ingestion status. Enforce any required matter-level access restrictions in policies. Treat retrieved documents and web text as untrusted evidence, never as authority to change tool behavior or access scope.

## Recommended implementation order

1. Fix false-clean reviews, version binding, cross-matter ID checks, silent standard fallbacks, and ignored persistence errors. Make statuses truthful before expanding capabilities.
2. Build a single document service around immutable template versions, exact artifact versions, approved clause variants, structured deal fields, tracked changes, and deterministic validation. Use it from Ask, Draft, Edit, Verify, and export.
3. Connect a queued research service to chat and project intake. Reuse the existing resolver/monitor after unifying evidence validation and amendment-aware retrieval.
4. Add clause-by-clause review with explicit coverage, evidence-linked findings, automatic revalidation after accepted edits, and clear reviewer sign-off state.
5. Improve chat ergonomics: visible active document/version and standard, research progress, clickable quotations, missing-fact checklist, per-change accept/reject/undo, and direct verification of an unsaved artifact. The current Verify path requires a project document version.

The central workflow should be: project facts + pinned standard → evidence research → draft or targeted edit → structural/format/content/legal checks → repair or explicit unresolved items → lawyer review → saved version. Formatting fidelity is a testable engineering contract for supported templates; legal completeness should remain an evidence-backed review result with stated limits.

## Validation performed and release criteria

- `npm run build`: passed; emitted a large-bundle warning and stale Browserslist-data notice.
- `npm run typecheck`: failed in `src/hooks/useMatterRelevantLaws.ts:24` (`status` too broadly typed) and `src/hooks/useRedline.ts:48` (`review_type` too broadly typed).
- Synthetic local DOCX XML/ZIP exercise: simple replace/accept and untouched-content preservation passed; edited paragraph attribute preservation failed; header placeholders were not exposed to the model.
- No dedicated automated Ask/Draft/Edit/Verify quality suite was found in the inspected paths. The checked-in QA bot's scenario still refers to an unrelated deal/thesis/fasteners workflow. Existing browser QA does not establish legal or document fidelity.
- No live provider calls, production writes, deployments, or authenticated browser checks were performed.

Before release, assemble firm-approved reference documents and lawyer-labelled cases covering long contracts, tables, multiple sections, header/footer placeholders, repeated terms, mixed run formatting, existing tracked changes, Urdu/RTL where needed, amendments, missing law, and conflicting project versions. Require supported format checks to pass, zero unexplained edits outside the requested scope, no silent failures, exact version provenance, and correct detection of all seeded critical defects. Measure legal finding precision/recall and citation support against lawyer-reviewed answers; define those thresholds with the firm. Test concurrency and stale-version scenarios as well as model behavior.

## Deployment note, 11 September 2026 (evening)

Everything above was applied and deployed: the `ai_quality` migration, the
three review edge functions, the chat service on the Oracle VM, and the
frontend.

Verifying it against a real firm document found that a full review does not
fit in a Supabase edge function at all. On the M6 term sheet (58,000
characters of extracted text) each arrangement fails a different limit:

| Arrangement | Outcome |
|---|---|
| Three passes at once | `WORKER_RESOURCE_LIMIT` — out of memory |
| Three passes in sequence | `IDLE_TIMEOUT` — past the 150-second ceiling |

Three contributing sizes were cut along the way and are worth keeping
whatever happens next: the standard template was being sent whole (526,000
characters for a Concession Agreement, about 130,000 input tokens a pass) and
is now capped at 40,000; retrieved excerpts were uncapped, and precedent rows
in this database average 54,000 characters with the largest at 11MB, so they
are now capped at 8,000 each as the chat endpoint already does; and a pass
may now return at most 20 findings with 16,000 output tokens, since 12,000
truncated the pass and a truncated pass is correctly failed rather than
reported clean.

Even with all three, the document does not fit. The review has to move to the
Oracle VM the way the chat endpoint did, where there is no isolate memory
ceiling and no 150-second wall clock. Until then, reviews complete on short
documents and fail honestly on long ones — which is the intended behaviour of
finding 1, but it means the feature is unavailable for the firm's real
agreements.
