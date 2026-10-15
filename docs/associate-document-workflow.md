# Consistent document workflow for associates

Product proposal added to the [chat audit](chat-audit-2026-09-16.md), following the requirement that Draft, Review/Verify, Edit and related features should work consistently, especially for redlining and tracked changes. This defines the intended behavior; implementation progress is recorded below.

Implementation progress: the first small slice now gives artifacts marked `truncated` the same incomplete-draft notice in Word and text panels, labels their chat cards and save actions, and disables Set as standard for incomplete Word artifacts. Typecheck, production build and local browser checks passed. This uses the existing completeness flag; detecting all unfinished outputs, resuming them, preserving completeness through later revisions/project saves, and the unified change-decision model remain separate work.

## Associate experience

An associate opens or creates a document, gives instructions, reviews proposed changes, and saves a version. Draft, Review, Edit and Summarise use the same document workspace and controls. Switching actions keeps the document, its pending changes, the conversation, and its project destination.

The workspace always identifies:

- **Working document:** name, project, saved version, and whether there are unsaved changes.
- **Sources:** reference documents and their exact versions, separate from the document being changed.
- **Changes:** proposed edits, their reasons, and Accept/Reject controls.
- **Checks:** issues found, evidence, checks not completed, and whether results still apply to the current revision.

Every generated document is immediately available for further editing, review, and saving. An associate should not need to download and re-upload a draft to review it, file an upload before editing it, or start a new conversation simply to change the task.

## Shared behavior across actions

| Action | What it starts from | What it produces | How the associate handles it |
| --- | --- | --- | --- |
| Draft from a standard | A pinned copy of the selected standard | A new working document with proposed fills and edits against that standard | Review changes, accept/reject, save the first project version |
| Draft without a standard | Instructions and selected sources | A complete first working draft; its creation is recorded as the initial baseline | Read the draft, request changes or run Review, save the first project version |
| Edit | The exact open working revision | Proposed changes to that document | The same Changes panel and Accept/Reject controls |
| Review / Verify | The exact open working revision, including an unsaved draft or upload | Check results, anchored comments, and proposed wording changes where appropriate | Check findings and use the same Changes panel; no automatic acceptance |
| Summarise | One or more selected reference documents | A separate memo with its own document identity | Edit/review/save the memo with the same controls; source documents remain references |
| Compare | Two explicitly selected versions | A comparison showing their differences | Inspect the differences; explicitly propose selected changes into the working document |
| Custom skill | The working revision and selected sources | A new document or proposed revision to the working document | The same provenance, completeness checks, Changes panel, and save/export contract |
| Build a standard | A pinned existing master or selected source documents | A working master and, if requested, a separate provenance note | The same review controls, followed by a distinct Publish standard action |

A newly written document has no meaningful earlier wording to redline. Its first complete output establishes the baseline; later revisions are tracked. A document created from a standard does have a baseline, so changes to that standard remain visible and pending. Template fills must no longer be silently accepted.

Use **Review** as the visible action name. Treat “verify” in instructions and existing links as entry points to the same review workflow. A check can establish a particular fact from evidence; the entire document should never receive an unexplained blanket “verified” status.

## One change model and one Changes panel

Every proposed edit, whether produced by Draft, Edit, Review, a custom skill, or an associate's manual editing, belongs to the same document revision and has:

- A stable change ID and exact location in the document.
- The original wording, proposed wording, and reason.
- The author, originating action/turn, and supporting evidence where relevant.
- A decision: **Pending**, **Accepted**, or **Rejected**.
- An application result: **Applied**, **Blocked by another change**, or **Could not locate the passage**.

Decision and application are distinct. An accepted suggestion that failed to apply must never look successfully incorporated. Findings without a supported wording change are comments/check results; they should not offer a misleading Accept button.

The associate can click a change in the document to open its card, or a card to locate its passage. Each card has Accept, Reject and a way to ask for revised wording. Resolved decisions can be undone while their anchors remain valid. “Accept all” and “Reject all” operate on the explicitly named set of pending changes for the current document; filters must not conceal their scope. Bulk acceptance is a deliberate action, never a side effect of download or saving.

Overlapping proposals are reconciled or presented as alternatives. Accepting one must not silently erase another. New AI turns receive the working document plus the outstanding proposals and decisions, so “shorten your proposed clause” or “keep my rejection of that wording” has a stable meaning.

Native Word revisions already present in an uploaded file retain their authors and history. App actions must target identified revisions, not accept every change by an author string. If a source revision type cannot be represented safely, preserve it and explain which decisions need to be made in Word.

## Preview, download and save must agree

| Control | Required behavior |
| --- | --- |
| Changes view | Shows accepted wording normally, pending edits as redlines, and rejected proposals removed from the document but retained in history |
| Current text view | Shows the document with accepted changes only; pending edits are not silently included. Keep the pending count visible |
| Accept / Reject | Records an associate's decision, updates the working document, and refreshes affected checks and previews |
| Download Word | Exports the same working state: accepted edits incorporated, pending edits tracked, rejected edits absent; preserves existing source revisions and comments |
| Download clean copy | Available when there are no unresolved revisions affecting the export. Otherwise directs the associate to resolve them; never accepts changes implicitly |
| Compare versions | Explicitly generates a historical comparison, which may show edits already accepted; this is separate from downloading the current working document |
| Save to project | First save creates a project document; subsequent saves create the next version of that same document. Preserves the current tracked-change state |
| Save as a separate document | Explicit secondary action with a new document identity |

Switching views never changes decisions. Accepted suggestions must not reappear as pending Word revisions merely because Download was used. The current Review download path does that today and needs to change.

Comments are separate from tracked revisions. A clean copy means revisions are resolved, not that comments were deleted. Comment removal is a separately labelled export option; internal guidance is visibly identified before external distribution or publication. Do not silently strip drafting guidance when publishing a standard.

Autosave working edits and decisions with a visible **Saving / Saved / Could not save** indicator. Creating a numbered project version remains an explicit action. Download and Save to project both use the same acknowledged working revision; neither should read an older artifact body or export a different state from the preview.

Saving is not legal approval. Pending changes may be saved in a working project version, clearly identified as pending. An incomplete generation is prominently marked; saving it requires an explicit “Save incomplete draft” action, and it cannot be published as an approved standard.

## Fewer workflow choices for associates

1. **Open or attach:** uploading, selecting a project version, opening a draft card, and selecting a standard all use the same document picker and reader. Default to the latest project version, but allow an explicit historical version.
2. **Identify the target:** attachments are sources unless selected as the working document. With several plausible targets, ask once which one to change. Never pick a different version from the one displayed.
3. **Give an instruction:** quick actions such as Draft, Review and Summarise fill a task request. They do not create invisible, sticky server modes. “Review this” uses the open working document, including unsaved changes.
4. **Inspect the result:** changes, unresolved questions and check limitations appear beside the same document. An answer-only request produces no document mutation.
5. **Save or download:** controls keep the same labels and meanings regardless of the action that produced the document.

Starting a different document type creates a separate document with its own standard and destination. It can remain in the conversation. When a turn produces two documents, show separate named cards and explicitly indicate which document is active; do not repeatedly switch the panel as files arrive.

Preserve the working document, unsent composer draft, and pending changes when switching chats or actions. Use one conversation surface for review questions and editing instructions. The secondary review chat should feed the same persisted conversation rather than have its own incomplete history and different backend.

For PDF, scans, spreadsheets and slides, keep the same selection, source inspection, review and saving concepts, while stating the actual output capability. Native Word redlining requires a Word working document. Offer an explicit conversion where supported, retain the original as evidence, and disclose layout loss and extraction gaps. A redline of converted text must not be presented as native editing of the original PDF or spreadsheet.

## Shared document state underneath the UI

Unifying the buttons alone will not fix the inconsistencies. Use shared services and durable state for all actions:

| Record/service | Responsibility |
| --- | --- |
| Working document | Stable identity, active revision, project destination, last saved project version, original file and pinned standard |
| Revision | Immutable input/output identity and content hashes, parent revision, supported content representation, provenance and completeness |
| Change set | Anchored operations, reasons, authors, decisions, application results and decision history |
| Check run | Exact revision reviewed, check scope, evidence snapshots, coverage/limitations and results |
| Turn | Request ID, target revision, instruction, source manifest, progress and terminal status, including resumable failures |
| Document reader | Shared extraction and format validation, full-text/section access, persistent attachments, exact version resolution and read coverage |
| Document renderer | One implementation that materializes the revision and change decisions for preview, save and download |
| Save service | One transactional version-save path with expected-base checks, idempotency and indexing state |

Draft and Review can retain different reasoning strategies. They must return compatible documents, change sets and checks. Adapt existing native DOCX operations and review suggestions into that contract instead of maintaining two independent decision systems.

Keep historical artifacts immutable. An old card opens its actual old revision, with a clear option to return to the current document or branch from that revision. A subsequent action never silently upgrades the selected old revision to the latest one.

Checks are tied to exact document content. After edits, mark affected results **Needs recheck** and retain the previous evidence/history. Rechecking adds a new run without dropping pending changes or changing the saved destination. Two associates making concurrent changes must receive a conflict or explicit branch, never an accidental last-writer-wins document.

Custom skills returning an entire replacement DOCX need a comparison against the pinned input. Publish locatable differences as proposed changes; if a safe comparison cannot be made, show a separate output and explain that it has not been merged. Do not imply all skill output can automatically preserve the input's formatting or redlines.

## Implementation sequence

1. **Identity and persistence:** fix audit findings 4, 14–17, 23–30. Establish exact working revisions, durable turns and inherited save destinations. Preserve draft input and recover uncertain writes.
2. **Shared changes and rendering:** adapt Edit and Review to one change-set schema, decision API and preview/export materialization path. Track standard fills; add the same Changes panel to Draft and generated memos. Fix findings 18–22 and 31.
3. **Continuous associate workflow:** support review/edit of unsaved drafts and uploaded documents, consolidate review chat, make task changes explicit, and standardize pickers/actions. Fix findings 2, 25 and 32–36.
4. **Trustworthy evidence and reliability:** unify extraction, durable attachments, current-question retrieval, citation identity, completeness and indexing behavior using the remaining audit work. Add orphan cleanup and performance limits.

These stages are ordered work, not permission gates. Existing replies and artifacts remain readable while older records are adapted; do not infer that a historical AI change was accepted simply because the old implementation wrote it directly into a file.

## Acceptance scenarios

- Draft from a standard → accept some changes → reject others → Review → ask for a rewrite → save v1 → edit → save v2. The same document, decisions, sources and save destination persist throughout.
- Generate a new memo → ask to shorten one section → inspect tracked edits → reject one → download. Unrequested content remains intact.
- Upload a DOCX → Review → resolve a suggestion → Edit → download. The displayed file and Word file represent the same decisions; existing third-party revisions survive.
- Save v2, open v1 and compare. Both versions are explicit; an instruction against v1 cannot silently edit v2.
- Download Word from Draft, Edit and Review with identical pending/accepted/rejected changes. All three exports have equivalent semantics.
- Switch views, download, and save while changes are pending. None of these operations changes an acceptance decision.
- Attempt a clean export with pending or unsupported revisions. The app explains what remains rather than silently accepting it.
- Ask a question about a previous review answer. The shared conversation and exact reviewed revision are available.
- Make overlapping edits, or have two associates edit concurrently. Show a resolvable conflict and preserve both proposals.
- Stop generation, lose the connection, or fail a persistence write. Preserve the instruction and output recovered so far, show an honest state, and resume without duplicate changes.

Success measures: fewer manual download/re-upload steps; fewer choices before the first useful result; consistent save/export behavior; no unexplained document switches; and no silent loss of changes, decisions or evidence. Measure task completion time and recovery success with representative associate workflows before claiming a usability improvement.

## How it is built (slice 1)

Slice 1 is the server side of "one change model and one Changes panel". It is what the panel (slice 2) and the single save/download path (slice 3) are built on. The short version: every change the AI makes to a Word file, whether it came from Edit or from Review, is a tracked change by the author `AKLA AI` in the conversation's working Word file, recorded as one row, and decided once by accepting or rejecting exactly that tracked change in the file.

**The table.** `public.redline_suggestions` is the one change record. The existing table was extended, not replaced: a row now also carries the working document it belongs to (`artifact_id`), the conversation and turn that made it (`thread_id`, `message_id`), what kind of change it is (`op`: `replace`, `insert_after` or `delete`), which part of the Word file it sits in (`part`: the body, a header, a footer, footnotes or endnotes), where it was placed (`placement` and `placement_reason`), the Word revision ids it owns (`revision_ids`), who made it and who decided it (`created_by`, `decided_by`, `decided_at`). Rows from before this slice keep `document_version_id` and are still shown by text match through the old review preview; new rows have `artifact_id` instead. A row always has one or the other. Comments are never rows: they have nothing to accept or reject, so they stay in the artifact's change summary and the reply.

**The id rule.** A change is identified by the Word revision ids (`w:id` on `w:ins` and `w:del`) it minted, not by its wording or paragraph number. One change can mint several ids (a replacement is one deletion per struck run plus one insertion; a deleted paragraph is its paragraph mark plus one id per run), and the row holds all of them. A decision resolves all of them together or none of them. Ids are never re-minted within a working document: before any write, the floor is the highest of every `w:id` already in any story part of the file and the highest id in any row of that document, and new ids count up from there. This covers ids written by other people in Word and ids on formatting changes the old count missed, so an accept or reject can never land on someone else's revision.

**The opening row.** The working document is the first artifact in the conversation's lineage, the root. It always exists before any work: when a turn starts from a project version, a standard, or a `.docx` uploaded that turn, the server first inserts an opening copy (`producedBy: 'open'`) whose `workingDocumentId` is its own id. Every copy the server writes afterwards carries the same `workingDocumentId`. The newest copy is the head, which is what preview, download and save all read. A copy produced by an AI turn is never changed again; decisions made between two AI turns are written to one decision copy that is updated in place, so forty single decisions leave one extra row, not forty.

**The three routes.** All take JSON with the user's bearer token and return plain-sentence errors.

- `POST /changes/list { artifactId }` returns the working document id, the head as a summary (its id, bucket, storage path, file name, title, updated time), every change as a numbered card, and the counts. The two file-derived counts (other people's revisions, unlisted AI changes) come from what the server stored with the copy when it wrote it; the file is only read for an opening row or a copy from before they were stored.
- `POST /changes/decide { artifactId, decisions: [{ changeId, decision }] }` accepts or rejects the named changes in the head file, uploads the result as the new head, stamps who decided and when, and returns the named cards, the counts and `notDone` for anything it could not decide (already decided, could not be placed, needs Word, replaced, or the wording changed since). Its `head` is the head's artifact row itself, not the summary: `head.data.storagePath` is the file to show and `head.data.changeCounts` the counts as stored on it. The storage path changes on every applied decision; the head may be a new row or the same decision row updated in place, so always use the returned one. It answers 409 if the document changed while deciding, and 422 if the rewritten file fails validation, in which case nothing is written.
- `POST /documents/file { artifactId, form }` returns the `.docx` bytes. `tracked` is the head file byte for byte. `clean` refuses with 409 (the sentence and the counts in the body) while any change is still waiting ("Decide the N changes waiting for you first."), while any can only be decided in Word, while the file carries AI changes the list does not name ("This file has N AI changes that are not in the Changes list. Decide them in Word first."), or while other people's tracked changes remain and `acceptOthers` was not set; otherwise it returns the file with the AI's changes accepted. This route always reads the file itself, never a stored count, because a clean copy accepts every AI revision in it. Nothing is accepted as a side effect of a download, a save, a preview or a follow-up.

Only the two chat turns that write a copy and `/changes/decide` write to a working document, and they take turns on it: the head check, the file upload, the artifact row and its change rows happen under one in-process lock per working document (the model call runs before it). The rows of an Edit turn are inserted before its copy, and a Review's copy is removed if its rows fail, so a copy never exists without the list that names its changes.

**The six states.** The server computes the state; the panel shows it and never derives it.

| State | Shown as | Meaning |
| --- | --- | --- |
| `waiting` | Waiting for you | The tracked change is in the file and undecided. |
| `accepted` | Accepted · by Name, date | Written into the text; the markup is gone. |
| `rejected` | Rejected · by Name, date | Removed from the text; the markup is gone. |
| `could_not_place` | Could not be placed | The wording was not found where expected; nothing in the file was changed. |
| `needs_word` | Needs Word | It can only be decided in Word. |
| `replaced` | Replaced | A later AI turn rewrote or removed this passage. |

A card in one of the last three states carries one sentence, shown verbatim. These are the sentences:

- Not found: "The quoted wording was not found in the document, so nothing was changed."
- Ambiguous: "The quoted wording appears more than once, so the assistant could not tell which place was meant. Nothing was changed."
- Overlaps another suggestion: "Another change already rewrote this wording. Decide that one first, then ask again if needed."
- Formatting: "This paragraph has formatting the assistant cannot edit safely. Make this change in Word."
- Formatting only: "Only spacing would change, so there is nothing to mark."
- Paragraph structure: "The suggestion restructures paragraphs in a way that cannot be shown as a tracked change."
- Missing text: "The suggestion did not quote the wording it would change."
- No change: "The suggested wording is the same as the document's."
- Stale: "The paragraph no longer reads as the assistant expected, so nothing was changed there."
- Hidden: "The assistant did not have that part of the document in view this turn. Ask again and it will read it first."
- Comment location: "Word does not allow comments in headers, footers or notes."
- Changed since: "The wording this change was made to is no longer in the document, so it could not be decided here."
- Paragraph merge: "This change joins two paragraphs. Accept or reject it in Word."
- Typed into: "Someone has typed into this added paragraph. Decide it in Word."
- Nested change: "A later change was made inside this one. Decide the later change first." (a `needs_word` state: a later AI change sits inside this one's tracked markup, so Word has to take them in order)
- Replaced: "Replaced by change N." (or "Replaced by a later AI change." when the later change is not in the list)
- Withdrawn: "Withdrawn by a later AI change."

Where a change came from is shown as its source label: Edit, Filled in from the standard, Review: legal clauses, Review: formatting, Review: content and conflicts, or Review follow-up. Counts come with every response: waiting, accepted, rejected, could not place, needs Word, replaced, total, the number of revisions by people other than the AI (`othersRevisions`), which the service never touches, and `unlisted`: the number of `AKLA AI` tracked changes in the head file that no row names. That is normally zero; it is not for a file the AI edited before this record existed, or a copy whose rows did not land. Those changes are decided in Word, never silently accepted here.

**What slice 2 (the one Changes panel) consumes.** It reads `workingDocumentId` and `changeCounts` from the artifact's data on first paint, loads cards with `/changes/list`, decides with `/changes/decide` (Accept all is the same call with every card that can be accepted), and shows the state, label, note, source label and decision verbatim. It finds a passage in the rendered head file by the card's before and after text. Every Word artifact opens in this one panel; old review artifacts open in the old review panel until that is retired. On any Word artifact event from the chat stream it refreshes the change list for that working document. It patches only the keys it owns in the artifact's data (the document type and the saved-version keys) and never writes over the storage path or counts.

**What slice 3 (one save, one download) consumes.** Download is `/documents/file` for both forms. Save takes the head file's bytes, the saved version it was opened from as the expected base, the document's current type, the root's title, and the waiting count for the label ("Save new version · 3 changes waiting"), then patches only the saved-version keys. A clean save is only offered when a clean download would succeed. The three older save paths fold into this one call, and the old review preview uploads stop with the old panel.
