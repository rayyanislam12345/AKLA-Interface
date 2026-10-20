// One AI change, from the moment it is written to the moment it is decided.
//
// Every change the AI makes to a Word file — from Edit or from Review — is a
// tracked change by "AKLA AI" in the thread's working document, known by the
// Word revision ids (w:id on w:ins / w:del) it minted, and recorded as one row
// in redline_suggestions. This module turns those rows into what the lawyer
// sees (a card with one plain state), decides a change by accepting or
// rejecting exactly its ids in the file, explains a row whose ids are no
// longer there, and builds the rows for the writers' results.
//
// Nothing here talks to the database or the network; the server passes bytes
// and rows in and writes what comes back.
import { readZip, writeZip, validateXml, child, attr, STORY_PART, PARAGRAPH, patchEmptyCells, suggestionParagraphs, xmlParts, DOCX_AUTHOR } from "./docxAgent.js";
import { inspectPackage } from "./docxChecks.js";

const dec = new TextDecoder();
const enc = new TextEncoder();

// The sentences the lawyer reads when a change could not be placed, could
// not be decided here, or was overtaken. The panel and the reply text both
// use these, so they never disagree.
export const PLACEMENT_TEXT = {
  not_found: "The quoted wording was not found in the document, so nothing was changed.",
  ambiguous: "The quoted wording appears more than once, so the assistant could not tell which place was meant. Nothing was changed.",
  overlaps_another_suggestion: "Another change already rewrote this wording. Decide that one first, then ask again if needed.",
  formatting: "This paragraph has formatting the assistant cannot edit safely. Make this change in Word.",
  formatting_only: "Only spacing would change, so there is nothing to mark.",
  paragraph_structure: "The suggestion restructures paragraphs in a way that cannot be shown as a tracked change.",
  missing_text: "The suggestion did not quote the wording it would change.",
  no_change: "The suggested wording is the same as the document's.",
  stale: "The paragraph no longer reads as the assistant expected, so nothing was changed there.",
  hidden: "The assistant did not have that part of the document in view this turn. Ask again and it will read it first.",
  comment_location: "Word does not allow comments in headers, footers or notes.",
  changed_since: "The wording this change was made to is no longer in the document, so it could not be decided here.",
  paragraph_merge: "This change joins two paragraphs. Accept or reject it in Word.",
  typed_into: "Someone has typed into this added paragraph. Decide it in Word.",
  nested_change: "A later change was made inside this one. Decide the later change first.",
  withdrawn: "Withdrawn by a later AI change.",
};

// The Edit writer refuses an operation with a sentence; the record keeps a
// code so the panel can show the same sentence as the reply.
const REFUSAL_CODES = {
  "Paragraph was not supplied to this turn; request that section first.": "hidden",
  "Expected paragraph text does not match the source; no change was made.": "stale",
  "Word does not allow comments in headers, footers or notes.": "comment_location",
  "no change": "no_change",
};
export function codeFor(reason) {
  if (reason === null || reason === undefined) return null;
  return Object.hasOwn(REFUSAL_CODES, reason) ? REFUSAL_CODES[reason] : String(reason);
}

// The one sentence under a card, or nothing when the state says it all.
export function placementNote(reason, { replacedByNumber = null } = {}) {
  if (!reason) return null;
  if (reason === "replaced") return replacedByNumber ? `Replaced by change ${replacedByNumber}.` : "Replaced by a later AI change.";
  return Object.hasOwn(PLACEMENT_TEXT, reason) ? PLACEMENT_TEXT[reason] : String(reason);
}

// ---------------------------------------------------------------- the file

const storyParts = (entries) => Object.keys(entries).filter((p) => STORY_PART.test(p));
const HAS_TEXT = /<w:t(?:\s[^>]*)?>[^<]/;
const stripDeletions = (xml) => xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, "");
// A revision's opening tag (not a self-closing paragraph mark) and its block.
const blockOf = (tag, id) => new RegExp(`<w:${tag}\\s[^>]*?\\bw:id="${id}"[^>]*?(?<!/)>([\\s\\S]*?)</w:${tag}>`, "g");
const markOf = (id) => new RegExp(`<w:(ins|del)\\s[^>]*?\\bw:id="${id}"[^>]*?/>`);

// Every w:ins / w:del id in a part, whoever made it.
function revisionIdsIn(xml) {
  const ids = new Set();
  for (const m of xml.matchAll(/<w:(?:ins|del)\s[^>]*?\bw:id="(\d+)"/g)) ids.add(Number(m[1]));
  return ids;
}

// The paragraph mark's own revision, if the paragraph has one with this id.
function paragraphMark(p, ids) {
  const pPr = child(p, "w:pPr");
  const rPr = pPr && child(pPr, "w:rPr");
  if (!rPr) return null;
  for (const id of ids) {
    const m = markOf(id).exec(rPr);
    if (m) return { tag: m[1], id, xml: m[0] };
  }
  return null;
}

// Why a decision cannot be made here: accepting a deleted paragraph mark
// whose paragraph still has live text would join it to the next paragraph,
// rejecting an added paragraph someone has typed into would lose their
// words, and rejecting an insertion that a later change was made inside
// would take that later change with it, undecided. Word can do all three
// with the lawyer watching; this must not. `deciding` is every id being
// decided in the same call: a later change decided alongside is no bar.
function blockedReason(xml, item, deciding = new Set(item.revisionIds)) {
  for (const p of xml.match(PARAGRAPH) ?? []) {
    const mark = paragraphMark(p, item.revisionIds);
    if (!mark) continue;
    if (mark.tag === "del" && item.decision === "accepted" && HAS_TEXT.test(stripDeletions(p))) return "paragraph_merge";
    if (mark.tag === "ins" && item.decision === "rejected") {
      let remaining = p;
      for (const id of item.revisionIds) remaining = remaining.replace(blockOf("ins", id), "");
      if (HAS_TEXT.test(stripDeletions(remaining))) return "typed_into";
    }
  }
  if (item.decision === "rejected") {
    for (const id of item.revisionIds) {
      for (const m of xml.matchAll(blockOf("ins", id))) {
        for (const inner of revisionIdsIn(m[1])) if (!deciding.has(inner)) return "nested_change";
      }
    }
  }
  return null;
}

// The exact inverse of marking a paragraph mark: the mark goes, and so do
// the properties that were only written to hold it.
function withoutMark(p, markXml) {
  const pPr = child(p, "w:pPr");
  const tidy = pPr.replace(markXml, "").replace("<w:rPr></w:rPr>", "");
  return p.replace(pPr, tidy === "<w:pPr></w:pPr>" ? "" : tidy);
}

// Paragraph marks first: a decided mark adds or removes the whole paragraph,
// or just stops being a revision.
function decideParagraphMarks(xml, items) {
  return xml.replace(PARAGRAPH, (p) => {
    for (const item of items) {
      const mark = paragraphMark(p, item.revisionIds);
      if (!mark) continue;
      const drop = (mark.tag === "del") === (item.decision === "accepted");
      return drop ? "" : withoutMark(p, mark.xml);
    }
    return p;
  });
}

// Then the runs: an accepted insertion or a rejected deletion becomes plain
// text, the reverse goes. A rejected deletion is the exact inverse of
// striking it out, so a footnote mark struck inside a run comes back whole.
function decideInline(xml, item) {
  for (const id of item.revisionIds) {
    if (item.decision === "accepted") {
      xml = xml.replace(blockOf("del", id), "").replace(blockOf("ins", id), "$1");
    } else {
      xml = xml
        .replace(blockOf("del", id), (_, inner) => inner.replace(/<w:delText(\s[^>]*)?>/g, "<w:t$1>").replace(/<\/w:delText>/g, "</w:t>"))
        .replace(blockOf("ins", id), "");
    }
  }
  return xml;
}

/**
 * Accepts or rejects changes by their revision ids.
 *
 * items: [{ id, part, revisionIds: number[], decision: 'accepted' | 'rejected' }]
 * Returns { bytes, results: [{ id, status: 'applied' | 'missing' | 'blocked', reason? }] }.
 *
 * All or nothing per item: unless every one of its ids is in its part, the
 * file is not touched for it ('missing'). A change Word has to decide is
 * left whole too ('blocked'). No id or date is minted, so the same input
 * always gives the same file.
 */
export function applyDecisions(bytes, items) {
  const entries = readZip(bytes);
  const results = [];
  const byPart = new Map();
  items.forEach((raw, n) => {
    const decision = raw.decision;
    if (decision !== "accepted" && decision !== "rejected") throw new Error(`Unknown decision "${decision}"`);
    const item = { n, id: raw.id, part: raw.part || "word/document.xml", decision, revisionIds: (Array.isArray(raw.revisionIds) ? raw.revisionIds : []).map(Number) };
    byPart.set(item.part, [...(byPart.get(item.part) ?? []), item]);
  });

  let changed = false;
  for (const [part, list] of byPart) {
    const xml = entries[part] ? dec.decode(entries[part]) : null;
    const present = xml ? revisionIdsIn(xml) : new Set();
    const found = [];
    for (const item of list) {
      if (!item.revisionIds.length || !item.revisionIds.every((id) => Number.isFinite(id) && present.has(id))) {
        results[item.n] = { id: item.id, status: "missing", reason: "changed_since" };
        continue;
      }
      found.push(item);
    }
    const deciding = new Set(found.flatMap((item) => item.revisionIds));
    const todo = [];
    for (const item of found) {
      const reason = blockedReason(xml, item, deciding);
      if (reason) results[item.n] = { id: item.id, status: "blocked", reason };
      else todo.push(item);
    }
    if (!todo.length) continue;
    let out = decideParagraphMarks(xml, todo);
    for (const item of todo) out = decideInline(out, item);
    entries[part] = enc.encode(patchEmptyCells(out));
    for (const item of todo) results[item.n] = { id: item.id, status: "applied" };
    changed = true;
  }

  if (!changed) return { bytes, results };
  validateXml(entries);
  const quality = inspectPackage(xmlParts(entries));
  if (quality.errors.length) throw new Error(`Decided file failed structural checks: ${quality.errors.join("; ")}`);
  return { bytes: writeZip(entries), results };
}

/**
 * Every tracked change in the file: ours as "part#id", and how many distinct
 * revisions anyone else has in it (which the service never touches).
 */
export function findRevisions(bytes) {
  const entries = readZip(bytes);
  const ours = new Set();
  const others = new Set();
  for (const part of storyParts(entries)) {
    for (const m of dec.decode(entries[part]).matchAll(/<w:(?:ins|del)\s[^>]*?>/g)) {
      const id = attr(m[0], "w:id");
      if (id === undefined) continue;
      (attr(m[0], "w:author") === DOCX_AUTHOR ? ours : others).add(`${part}#${id}`);
    }
  }
  return { ours, others: others.size };
}

/**
 * After any write, says what became of every waiting change whose ids are
 * no longer all in the file, so none is silently left "waiting" for a
 * decision that can no longer be made. Returns [{ id, patch }] for the rows
 * to update.
 *
 * results: the writer's results for the write that just happened. A result
 * that took over or removed an earlier change carries `takesOver` or
 * `removedIds`; one that split an earlier insertion carries `splits`. A
 * result's `rowId` is the row the server inserted for it, if any.
 */
export function reconcile(bytes, rows, results = []) {
  const entries = readZip(bytes);
  const present = new Set();
  for (const part of storyParts(entries)) for (const id of revisionIdsIn(dec.decode(entries[part]))) present.add(`${part}#${id}`);
  const inPart = (r, part) => (r.part ?? "word/document.xml") === part;
  const patches = [];
  for (const row of rows) {
    if (row.status !== "pending" || row.placement !== "placed") continue;
    const ids = (row.revision_ids ?? []).map(Number);
    if (!ids.length) continue;
    const part = row.part ?? "word/document.xml";
    const has = (list) => (list ?? []).some((id) => ids.includes(Number(id)));
    const takenBy = results.find((r) => inPart(r, part) && has(r.takesOver));
    if (takenBy) { patches.push({ id: row.id, patch: { placement: "superseded", placement_reason: "replaced", superseded_by: takenBy.rowId ?? null } }); continue; }
    if (results.some((r) => inPart(r, part) && has(r.removedIds))) { patches.push({ id: row.id, patch: { placement: "superseded", placement_reason: "withdrawn" } }); continue; }
    if (ids.some((id) => !present.has(`${part}#${id}`))) { patches.push({ id: row.id, patch: { placement: "unplaced", placement_reason: "changed_since" } }); continue; }
    // Our earlier insertion was split around a later change: the second
    // half's fresh id still belongs to the earlier change.
    const grown = results.flatMap((r) => (inPart(r, part) ? r.splits ?? [] : [])).filter((s) => ids.includes(Number(s.fromId))).map((s) => Number(s.toId));
    if (grown.length) patches.push({ id: row.id, patch: { revision_ids: [...new Set([...ids, ...grown])] } });
  }
  return patches;
}

// ---------------------------------------------------------------- records

const OPS = new Set(["replace", "insert_after", "delete"]);

/**
 * Rows for an Edit turn's results, one per operation that is a change to
 * the text (comments are not). A delete of a paragraph the AI itself added
 * earlier makes no row: Word simply removes an unaccepted insertion, so it
 * comes back as a withdrawal for the earlier row to be marked by reconcile.
 *
 * ctx: { threadId, rootId, userId, fillIn } — a fill-in from the firm's
 * standard is written straight in, so its rows are born accepted.
 */
export function editRecords(results, { threadId, rootId, userId, fillIn = false }) {
  const now = new Date().toISOString();
  const rows = [];
  const withdrawals = [];
  for (const r of results) {
    const op = String(r.kind ?? "").toLowerCase();
    if (!OPS.has(op)) continue;
    if (r.status === "applied" && r.removedIds?.length && !r.revisionIds?.length) { withdrawals.push(r); continue; }
    const placed = r.status === "applied";
    rows.push({
      thread_id: threadId,
      artifact_id: rootId,
      message_id: null,
      document_version_id: null,
      review_run_id: null,
      review_type: fillIn ? "standard_fill" : "edit",
      op,
      part: r.part ?? "word/document.xml",
      paragraph_index: Number.isFinite(Number(r.p)) ? Number(r.p) : null,
      clause_reference: r.clause ?? null,
      original_text: r.original ?? "",
      suggested_text: op === "delete" ? "" : r.modified ?? r.text ?? "",
      rationale: r.why ?? null,
      status: fillIn ? "accepted" : "pending",
      decided_by: null,
      decided_at: fillIn ? now : null,
      revision_ids: fillIn ? [] : r.revisionIds ?? [],
      placement: placed ? "placed" : "unplaced",
      placement_reason: placed ? null : codeFor(r.reason),
      created_by: userId,
    });
  }
  return { rows, withdrawals };
}

/**
 * Rows for a review's suggestions, from what the renderer did with each.
 * A placed suggestion is recorded in the document's own words; one that
 * could not be placed keeps the model's quote, with the HTML stripped.
 *
 * tagged: the review's suggestions, in order; results: applyReviewSuggestions
 * results whose `id` is the suggestion's index.
 * ctx: { threadId, rootId, userId, reviewType?, reviewRunId? }
 */
export function reviewRecords(tagged, results, { threadId, rootId, userId, reviewType = "chat", reviewRunId = null }) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const plain = (html) => suggestionParagraphs(html).join("\n");
  return tagged.map((s, i) => {
    const r = byId.get(s.id ?? i) ?? results[i] ?? null;
    const placed = r?.status === "applied";
    return {
      thread_id: threadId,
      artifact_id: rootId,
      message_id: null,
      document_version_id: null,
      review_run_id: reviewRunId,
      review_type: s.review_type ?? reviewType,
      op: "replace",
      part: r?.part ?? "word/document.xml",
      paragraph_index: r?.paragraphIndex ?? null,
      clause_reference: s.clause_reference ?? r?.clause ?? null,
      original_text: placed ? r.original ?? "" : plain(s.original_text),
      suggested_text: placed ? r.suggested ?? "" : plain(s.suggested_text),
      rationale: s.rationale ?? null,
      status: "pending",
      revision_ids: placed ? r.revisionIds ?? [] : [],
      placement: placed ? "placed" : "unplaced",
      placement_reason: placed ? null : codeFor(r?.reason ?? "not_found"),
      created_by: userId,
    };
  });
}

// ---------------------------------------------------------------- cards

const STATE_LABEL = {
  waiting: "Waiting for you",
  accepted: "Accepted",
  rejected: "Rejected",
  could_not_place: "Could not be placed",
  needs_word: "Needs Word",
  replaced: "Replaced",
};
const SOURCE_LABEL = {
  edit: "Edit",
  standard_fill: "Filled in from the standard",
  legal_clauses: "Review: legal clauses",
  formatting: "Review: formatting",
  content_conflicts: "Review: content and conflicts",
  chat: "Review follow-up",
};
const KIND = { replace: "change", insert_after: "addition", delete: "deletion" };

// Where a placement stands wins over the decision: a change that never
// reached the file has nothing to accept.
export function stateOf(row) {
  if (row.placement === "superseded") return "replaced";
  if (row.placement === "unplaced") return "could_not_place";
  if (row.placement === "blocked") return "needs_word";
  return row.status === "accepted" ? "accepted" : row.status === "rejected" ? "rejected" : "waiting";
}

function partLabel(part) {
  if (/^word\/header\d+\.xml$/.test(part)) return "header";
  if (/^word\/footer\d+\.xml$/.test(part)) return "footer";
  if (part === "word/footnotes.xml") return "footnotes";
  if (part === "word/endnotes.xml") return "endnotes";
  return "body";
}

const lookup = (map, key) => (map instanceof Map ? map.get(key) : map?.[key]);

/**
 * One change as the lawyer sees it. `number` is its place in the document's
 * list, `names` maps user ids to names, `numbers` maps row ids to their
 * numbers (for "Replaced by change N.").
 */
export function cardFor(row, { number, names = new Map(), numbers = new Map() } = {}) {
  const state = stateOf(row);
  const replacedByNumber = row.superseded_by ? lookup(numbers, row.superseded_by) ?? null : null;
  const note = state === "waiting" || state === "accepted" || state === "rejected" ? null : placementNote(row.placement_reason, { replacedByNumber });
  const decidedBy = row.decided_by ? { id: row.decided_by, name: lookup(names, row.decided_by) ?? null } : null;
  return {
    id: row.id,
    number,
    source: row.review_type,
    sourceLabel: SOURCE_LABEL[row.review_type] ?? "Edit",
    kind: KIND[row.op] ?? "change",
    where: { part: partLabel(row.part ?? "word/document.xml"), paragraph: row.paragraph_index ?? null, clause: row.clause_reference ?? null },
    before: row.original_text ?? "",
    after: row.suggested_text ?? "",
    why: row.rationale ?? null,
    state,
    stateLabel: STATE_LABEL[state],
    stateNote: note,
    decided: row.decided_at ? { by: decidedBy, at: row.decided_at } : null,
    turn: { messageId: row.message_id ?? null, at: row.created_at ?? null },
    replacedBy: row.superseded_by ?? null,
    canAccept: state === "waiting",
    canReject: state === "waiting",
  };
}

// The rows of one working document in the order they were made, numbered
// from 1, as cards. Rows of one turn share a time, so within it they go in
// the order of the document: by paragraph, then by part, then by id.
export function cardsFor(rows, names = new Map()) {
  const paragraph = (row) => (Number.isFinite(Number(row.paragraph_index)) && row.paragraph_index !== null ? Number(row.paragraph_index) : Number.MAX_SAFE_INTEGER);
  const ordered = [...rows].sort((a, b) =>
    String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))
    || paragraph(a) - paragraph(b)
    || String(a.part ?? "").localeCompare(String(b.part ?? ""))
    || String(a.id).localeCompare(String(b.id)));
  const numbers = new Map(ordered.map((row, i) => [row.id, i + 1]));
  return ordered.map((row) => cardFor(row, { number: numbers.get(row.id), names, numbers }));
}

export function countsFor(rows, others = 0) {
  const counts = { waiting: 0, accepted: 0, rejected: 0, couldNotPlace: 0, needsWord: 0, replaced: 0, total: rows.length, othersRevisions: others };
  const key = { waiting: "waiting", accepted: "accepted", rejected: "rejected", could_not_place: "couldNotPlace", needs_word: "needsWord", replaced: "replaced" };
  for (const row of rows) counts[key[stateOf(row)]]++;
  return counts;
}

// ---------------------------------------------------------------- counts

// AI revisions in the file that no row of the document accounts for: a
// copy made before rows were kept, or a turn whose rows never landed.
// Nothing here can decide them, and a clean copy must not accept them.
export function unlistedIn(rows, ours) {
  const listed = new Set();
  for (const row of rows) {
    if (row.placement !== "placed" && row.placement !== "blocked") continue;
    for (const id of row.revision_ids ?? []) listed.add(`${row.part ?? "word/document.xml"}#${id}`);
  }
  let n = 0;
  for (const key of ours) if (!listed.has(key)) n++;
  return n;
}

// A working document's counts: the rows say what each change is, the file
// says what else is in it (other people's revisions, unlisted AI ones).
export function countsWith(rows, revisions) {
  return { ...countsFor(rows, revisions.others), unlisted: unlistedIn(rows, revisions.ours ?? []) };
}

// ---------------------------------------------------------------- deciding

// The sentences a decision answers with, for a chat's working document and
// a stored version alike (server.js, versionChanges.js).
export const CHANGED_WHILE_DECIDING = "This document changed while you were deciding. Reload and try again.";
export const NO_CHANGES_YET = "There are no AI changes in this document yet.";

const NOT_DONE_REASON = { accepted: "already_decided", rejected: "already_decided", could_not_place: "could_not_place", needs_word: "needs_word", replaced: "replaced" };

// Why a row that is not waiting cannot be decided, in the panel's words.
export function notDoneFor(row) {
  const state = stateOf(row);
  const note = state === "accepted" || state === "rejected"
    ? `This change was already ${state}.`
    : placementNote(row.placement_reason) ?? "This change cannot be decided here.";
  return { changeId: row.id, reason: NOT_DONE_REASON[state], note };
}

// What applyDecisions could not do: a change whose ids are gone from the
// file is recorded as no longer placed, one Word has to decide as blocked.
// Neither touches the file.
export function undecidable(result) {
  const missing = result.status === "missing";
  return {
    notDone: { changeId: result.id, reason: missing ? "changed_since" : "needs_word", note: PLACEMENT_TEXT[result.reason] ?? String(result.reason) },
    patch: missing ? { placement: "unplaced", placement_reason: "changed_since" } : { placement: "blocked", placement_reason: result.reason },
  };
}

// Why a clean copy cannot be made yet, or null. Nothing is accepted
// implicitly: the lawyer's own undecided changes, ones only Word can
// decide, and other people's revisions all stop it.
export function cleanRefusal(counts, acceptOthers) {
  const plural = (n) => (n === 1 ? "" : "s");
  if (counts.waiting > 0) return `Decide the ${counts.waiting} change${plural(counts.waiting)} waiting for you first.`;
  if (counts.needsWord > 0) return `${counts.needsWord} change${plural(counts.needsWord)} can only be decided in Word. Download the tracked copy and decide ${counts.needsWord === 1 ? "it" : "them"} there first.`;
  if (counts.unlisted > 0) return `This file has ${counts.unlisted} AI change${plural(counts.unlisted)} that ${counts.unlisted === 1 ? "is" : "are"} not in the Changes list. Decide ${counts.unlisted === 1 ? "it" : "them"} in Word first.`;
  if (counts.othersRevisions > 0 && acceptOthers !== true) {
    return `This file still has ${counts.othersRevisions} tracked change${plural(counts.othersRevisions)} by other people. Accept them in Word, or ask for a copy with them accepted.`;
  }
  return null;
}

// ---------------------------------------------------------------- locking

// Decisions on one working document run one after another. The service is
// one Node process, so a promise chain per document is the whole lock.
const locks = new Map();
export function withDocumentLock(id, fn) {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => undefined, () => undefined);
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return run;
}
