// Filing a finished review into the Hub: one model wherever the review was
// started (the Hub's Review button, the Hub chat, claude.ai's start_review).
//
// A review run (review.js runReview) records its findings against the
// version it read. The owner's direction (22 October 2026) is that a
// finished review is filed automatically: its findings are placed as
// "AKLA AI" tracked changes in the lawyer's own file (docxAgent
// applyReviewSuggestions, as the Hub chat's in-file review writes them),
// the result is saved as the NEXT version of the same project document, and
// each placed finding becomes one change row on that new version
// (versionChanges.js: review_type 'edit', anchored to the version, the Word
// revision ids it minted). From then on the lawyer only decides: in the
// Hub's Changes list for that version (DocumentViewer's Changes tab) or, in
// claude.ai, in the changes panel. The review's own rows on the reviewed
// version say where each finding went (placed: moved to the new version's
// row, as a carried change is; could not be placed, with the reason; or
// left out at the lawyer's word), so no finding waits in two places.
//
// What is filed is recorded on the run itself, as coverage.filing (no new
// column): filed (the new version, the counts, the findings that could not
// be placed), newer_version (the document gained a newer version while the
// review ran, so nothing was placed over it: the findings quote the older
// version's words), none_placed, format_refused (the format check, as the
// Hub chat's review applies it), nothing_found, not_word (a PDF review is
// listed, never filed) or failed. get_review and the Hub's review panel
// read it from there.
//
// Three ways in:
// - fileReviewRun: the automatic filing when a run completes, and
//   apply_review_to_version's re-placing (the findings placed again, less
//   the ones the lawyer leaves out, as a fresh next version of the filed
//   one, before any of its changes is decided);
// - fileFollowUp: the corrections a follow-up instruction in the Hub chat
//   calls for, placed as a further version of the filed one;
// - placeRows underneath both.
//
// One placement at a time per process (a long agreement read whole and
// rewritten is a few hundred MB resident, as markup.js's lock says). Shared
// by chat-service (server.js) and the connector (connector/reviewRuns.js,
// connector/tools/reviews.js); every function takes the service-role
// client and a `save` that files the next version as the lawyer
// (connector/projectWrites.js saveVersion). Node 20.

import { randomUUID } from "node:crypto";
import { applyReviewSuggestions } from "./docxAgent.js";
import { checkFormat } from "./formatFingerprint.js";
import { reconcile, codeFor, stateOf, placementNote } from "./changes.js";
import {
  versionOf, workingFileOf, downloadFile, versionRows, highestRecordedVersionId, latestVersionOf, carryForward, isWordPath, VERSION_ROW_TYPE, DOCX_MIME,
} from "./versionChanges.js";

export const FILED = "filed";
export const NEWER_VERSION = "newer_version";
/** The statuses coverage.filing records; the rest (busy, moved, stopped, decided_in_filed, nothing_left) are only answered. */
export const RECORDED_STATUSES = Object.freeze([FILED, NEWER_VERSION, "none_placed", "format_refused", "nothing_found", "not_word", "failed"]);
const MAX_FINDINGS = 500;
const MAX_LABEL_CHARS = 200;

/** The passes, in the order findings are listed, and what the lawyer reads for each. */
export const PASSES = Object.freeze(["legal_clauses", "formatting", "content_conflicts", "chat"]);
const PASS_LABEL = { legal_clauses: "legal clauses and citations", formatting: "formatting and structure", content_conflicts: "content and conflicts", chat: "follow-up" };
export const passLabel = (t) => PASS_LABEL[t] ?? String(t ?? "review").replace(/_/g, " ");

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Karachi" });
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** "Review suggestions placed — 22 October 2026", the lawyer's label in front when given. */
export function reviewLabel(label, at = new Date(), what = "Review suggestions placed") {
  const base = `${what} — ${dateFmt.format(at)}`;
  const own = oneLine(label);
  if (!own) return base;
  const room = MAX_LABEL_CHARS - base.length - 2;
  return `${own.length > room ? `${own.slice(0, room - 1)}…` : own}: ${base}`;
}

/** The note a reviewed version's row carries once its finding is in the new version. */
export const placedNote = (versionNumber) => `Placed in v${versionNumber} as a tracked change; decide it there.`;

// ---------------------------------------------------------------- the order of the findings

// A clause reference's numbers ("Section 14.2" -> [14, 2]), or null.
function clauseKey(ref) {
  const m = /(\d+(?:\.\d+)*)/.exec(String(ref ?? ""));
  return m ? m[1].split(".").map(Number) : null;
}

/**
 * The findings in the order get_review numbers them (and the exclusions and
 * the could-not-place lists name them): by clause number (references
 * without one after), then by reference, by pass, and by id, so the
 * numbering is the same on every call. complete_ai_review inserts a run's
 * rows in one statement, so their times do not order them.
 */
export function orderFindings(rows) {
  const passAt = (t) => { const i = PASSES.indexOf(t); return i === -1 ? PASSES.length : i; };
  return [...(rows ?? [])].sort((a, b) => {
    const ka = clauseKey(a.clause_reference);
    const kb = clauseKey(b.clause_reference);
    if (ka && !kb) return -1;
    if (!ka && kb) return 1;
    if (ka && kb) {
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        const d = (ka[i] ?? -1) - (kb[i] ?? -1);
        if (d) return d;
      }
    }
    return String(a.clause_reference ?? "").localeCompare(String(b.clause_reference ?? ""), "en", { numeric: true })
      || passAt(a.review_type) - passAt(b.review_type)
      || String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))
      || String(a.id).localeCompare(String(b.id));
  });
}

/** The run row, or null. */
export async function readRun(supabase, runId) {
  const { data, error } = await supabase.from("ai_review_runs").select("id, document_version_id, artifact_id, status, passes, coverage, error, created_at, created_by").eq("id", runId).maybeSingle();
  if (error) throw new Error(`Could not read the review: ${error.message}`);
  return data ?? null;
}

/** What the run's filing record says, or null (not filed yet, or a run from before filing). */
export const filingOf = (run) => (run?.coverage && typeof run.coverage === "object" && run.coverage.filing && typeof run.coverage.filing === "object" ? run.coverage.filing : null);

/** The review's findings on the version it read, in get_review's order. */
export async function findingsOf(supabase, run) {
  const { data, error } = await supabase
    .from("redline_suggestions")
    .select("id, clause_reference, original_text, suggested_text, rationale, review_type, status, placement, placement_reason, superseded_by, created_at")
    .eq("review_run_id", run.id)
    .eq("document_version_id", run.document_version_id)
    .limit(MAX_FINDINGS);
  if (error) throw new Error(`Could not read the review's findings: ${error.message}`);
  return orderFindings(data ?? []);
}

/** Writes the run's filing record into coverage.filing, keeping what the review recorded there. Never throws. */
export async function recordFiling(supabase, runId, filing, log = () => {}) {
  try {
    const { data, error } = await supabase.from("ai_review_runs").select("coverage").eq("id", runId).maybeSingle();
    if (error) throw new Error(error.message);
    const coverage = data?.coverage && typeof data.coverage === "object" ? data.coverage : {};
    const { error: updateError } = await supabase.from("ai_review_runs").update({ coverage: { ...coverage, filing } }).eq("id", runId);
    if (updateError) throw new Error(updateError.message);
    return true;
  } catch (err) {
    log(`review ${runId}: the filing record could not be written: ${err?.message ?? err}`);
    return false;
  }
}

// ---------------------------------------------------------------- one placement at a time

let queued = 0;
let tail = Promise.resolve();

/**
 * Runs `fn` when no other placement is running in this process. With
 * `wait: false` (a tool call the lawyer is waiting on) a placement already
 * running answers { status: "busy" } at once; the automatic filing waits.
 */
export async function withPlacement(fn, { wait = true } = {}) {
  if (!wait && queued > 0) return { status: "busy" };
  queued += 1;
  const before = tail;
  let release;
  tail = new Promise((r) => { release = r; });
  try {
    await before;
    return await fn();
  } finally {
    queued -= 1;
    release();
  }
}

// ---------------------------------------------------------------- placing

/**
 * Places `chosen` (finding rows: id, clause_reference, original_text,
 * suggested_text, rationale, review_type) into `bytes` (the working file of
 * `base`), checks the format against that file, and files the result as the
 * next version of the document, refused by the database if the newest
 * version is no longer `expectedLatestId`. The new version's Changes list
 * is written after the save: `carry` (rows whose revisions are in the file
 * and still waiting) carried forward, then one 'edit' row per finding
 * placed. Does not touch the finding rows themselves; the caller says where
 * each went. Returns { status, ... }: filed, none_placed, format_refused,
 * moved (a decision moved the file on meanwhile), stopped, newer_version or
 * failed.
 */
async function placeRows({ supabase, base, doc, file, bytes, chosen, carry, expectedLatestId, userId, save, label, isAiGenerated, apply, format, log, shouldStop }) {
  let out;
  try {
    const idFloor = Math.max(9000, await highestRecordedVersionId(supabase, doc.id));
    out = apply(bytes, chosen.map((x, i) => ({ id: i, original: x.original_text, suggested: x.suggested_text, accepted: false, clause: x.clause_reference ?? null })), { idFloor });
  } catch (err) {
    return { status: "failed", error: `the findings could not be written into the file (${err?.message ?? err})` };
  }
  const results = out.results;
  const placed = results.filter((r) => r.status === "applied");
  const notPlaced = results.filter((r) => r.status !== "applied").map((r) => ({ finding: chosen[r.id], reason: codeFor(r.reason) ?? "not_found" }));
  if (!placed.length) return { status: "none_placed", notPlaced };
  const gate = format(out.bytes, bytes, { base: file.fileName, subject: "the version it was made from" });
  log(`review filing: format ${gate.result.status}${gate.refused ? " (refused)" : ""}`);
  if (gate.refused) return { status: "format_refused", format: gate, notPlaced };
  // The file must still be the one written into: a decision in the Hub
  // meanwhile moves the working file on.
  const again = await workingFileOf(supabase, base);
  if (again.storagePath !== file.storagePath) return { status: "moved" };
  if (shouldStop()) return { status: "stopped" };

  let saved;
  try {
    saved = await save({
      projectId: doc.matter_id, title: doc.title, matterDocumentId: doc.id, expectedVersion: expectedLatestId,
      bytes: out.bytes, fileName: `${doc.title}.docx`, mime: DOCX_MIME, labelVerbatim: label, isAiGenerated,
    });
  } catch (err) {
    const message = String(err?.message ?? err);
    return { status: /newer version exists/i.test(message) ? NEWER_VERSION : "failed", error: message };
  }
  const rows = await writeRows({ supabase, saved, bytes: out.bytes, chosen, results, carry, userId, log });
  return {
    status: FILED, saved, format: gate, notPlaced, ...rows,
    placed: placed.map((r) => ({ finding: chosen[r.id], rowId: r.rowId ?? null, original: r.original ?? chosen[r.id].original_text })),
  };
}

/**
 * The new version's Changes list: `carry` carried forward (their revisions
 * are in this file too), one row per finding placed (review_type 'edit',
 * anchored to the new version, the Word revision ids it minted; the pass
 * and reason in its "why"), then what the placement did to the carried
 * ones (a carried change a finding rewrote is "Replaced by change N",
 * applyReviewSuggestions' takesOver). A failure is said, never thrown: the
 * version is filed and its changes are in the file, decidable in Word.
 */
async function writeRows({ supabase, saved, bytes, chosen, results, carry, userId, log }) {
  try {
    const { clones, carried } = carryForward(carry, { toVersionId: saved.versionId, toVersionNumber: saved.versionNumber });
    const rows = [];
    for (const res of results) {
      const finding = chosen[res.id];
      if (!finding || res.status !== "applied") continue;
      const id = randomUUID();
      rows.push({
        id, document_version_id: saved.versionId, artifact_id: null, thread_id: null, message_id: null, review_run_id: null,
        review_type: VERSION_ROW_TYPE, op: "replace", part: res.part ?? "word/document.xml", paragraph_index: res.paragraphIndex ?? null,
        clause_reference: finding.clause_reference ?? res.clause ?? null,
        original_text: res.original ?? "", suggested_text: res.suggested ?? "",
        rationale: `Review (${passLabel(finding.review_type)}): ${oneLine(finding.rationale)}`.slice(0, 4000),
        status: "pending", revision_ids: res.revisionIds ?? [], placement: "placed", placement_reason: null, created_by: userId,
      });
      res.rowId = id;
    }
    const all = [...clones, ...rows];
    if (all.length) {
      const { error } = await supabase.from("redline_suggestions").insert(all).select("id");
      if (error) throw new Error(error.message);
    }
    for (const { id, patch } of carried) await supabase.from("redline_suggestions").update(patch).eq("id", id);
    const overtaken = clones.length ? reconcile(bytes, clones, results) : [];
    for (const { id, patch } of overtaken) await supabase.from("redline_suggestions").update(patch).eq("id", id);
    const gone = new Set(overtaken.filter((p) => p.patch.placement).map((p) => p.id));
    return { waiting: rows.length + clones.filter((c) => !gone.has(c.id)).length, carriedCount: clones.length, overtakenCount: gone.size, rowsError: null };
  } catch (err) {
    log(`review filing: the change rows for ${saved.versionId} could not be written: ${err?.message ?? err}`);
    for (const res of results) delete res.rowId;
    return { waiting: 0, carriedCount: 0, overtakenCount: 0, rowsError: String(err?.message ?? err) };
  }
}

/** Patches rows one by one; a failure is logged, never thrown (the filing already stands). */
async function patchRows(supabase, patches, log) {
  for (const { id, patch } of patches) {
    const { error } = await supabase.from("redline_suggestions").update(patch).eq("id", id);
    if (error) log(`review filing: row ${id} could not be updated: ${error.message}`);
  }
}

/** The filing record for coverage.filing: ids, numbers and counts, never the document's text. */
function filingRecord(outcome, { at, userId, version, extra = {} }) {
  const rec = { status: outcome.status, at: at.toISOString(), by: userId ?? null, reviewedVersionId: version.id, reviewedVersionNumber: version.version_number, ...extra };
  const notPlaced = (outcome.notPlaced ?? []).map((x) => ({ suggestionId: x.finding.id, reason: x.reason }));
  if (outcome.status === FILED) {
    Object.assign(rec, {
      versionId: outcome.saved.versionId, versionNumber: outcome.saved.versionNumber, fileName: outcome.saved.fileName ?? null, label: outcome.saved.label ?? null,
      placed: outcome.placed.length, waiting: outcome.waiting, notPlaced, rowsError: outcome.rowsError ?? null,
      formatNote: outcome.format && outcome.format.result?.status !== "matches" ? outcome.format.text : null,
    });
  } else if (outcome.status === NEWER_VERSION) {
    Object.assign(rec, { latestVersionId: outcome.latest?.id ?? null, latestVersionNumber: outcome.latest?.version_number ?? null });
  } else if (outcome.status === "none_placed") {
    rec.notPlaced = notPlaced;
  } else if (outcome.status === "format_refused") {
    rec.note = outcome.format?.text ?? null;
  } else if (outcome.status === "failed") {
    rec.note = outcome.error ?? null;
  }
  return rec;
}

/**
 * Files a complete review run, as the lawyer `userId`:
 *
 * - First filing (the run has no "filed" record): the findings still
 *   waiting, less `exclude` (finding ids), placed in the reviewed
 *   version's working file and filed as the next version, provided the
 *   reviewed version is still the document's newest. The reviewed version's
 *   own waiting AKLA AI changes are carried forward.
 * - Re-placing (the run was filed as vF): the findings placed again from
 *   the reviewed version, less `exclude`, as the next version after vF;
 *   refused unless vF is still the newest and nothing has been decided in
 *   it. vF's changes from this review are then marked as placed again (or
 *   left out), so they wait only in the new version.
 *
 * `save` files a version (connector/projectWrites.js saveVersion's
 * arguments, less ctx). `wait: false` answers busy rather than queueing;
 * `shouldStop()` is asked just before the save (a stopping connector files
 * nothing rather than half). The outcome of a first filing is recorded on
 * the run (coverage.filing); a re-placing records only a success. Returns
 * { status, run, version, doc, matter, findings, numberOf, ... }; throws only
 * when the run cannot be read.
 */
export async function fileReviewRun({ supabase, runId, userId, save, exclude = [], label = null, isAiGenerated = true, wait = true, apply = applyReviewSuggestions, format = checkFormat, now = () => new Date(), log = () => {}, shouldStop = () => false }) {
  const run = await readRun(supabase, runId);
  if (!run) throw new Error("There is no review with that run id.");
  if (run.status !== "complete") return { status: "not_complete", run };
  if (!run.document_version_id) return { status: "not_version", run };
  const version = await versionOf(supabase, run.document_version_id);
  if (!version) return { status: "gone", run };
  const doc = version.matter_document;
  const { data: matter } = await supabase.from("matters").select("id, name").eq("id", doc.matter_id).maybeSingle();
  const findings = await findingsOf(supabase, run);
  const numberOf = new Map(findings.map((f, i) => [f.id, i + 1]));
  const ctx = { run, version, doc, matter: matter ?? { id: doc.matter_id, name: null }, findings, numberOf };
  const previous = filingOf(run)?.status === FILED ? filingOf(run) : null;
  const at = now();
  const done = async (outcome, { record = !previous } = {}) => {
    const result = { ...ctx, previous, ...outcome };
    if (record && RECORDED_STATUSES.includes(outcome.status)) result.filing = filingRecord(outcome, { at, userId, version, extra: outcome.extra });
    if (result.filing) result.recorded = await recordFiling(supabase, run.id, result.filing, log);
    return result;
  };

  if (!isWordPath(version.storage_path)) return done({ status: "not_word" });
  if (!findings.length) return done({ status: "nothing_found" });
  const excluded = new Set((exclude ?? []).filter((id) => numberOf.has(id)));

  // Where the findings go, and what the new version carries forward.
  const latest = await latestVersionOf(supabase, version.matter_document_id);
  let expected = version.id;
  let carry;
  let priorRows = [];
  let filedVersion = null;
  if (previous) {
    if (!latest || latest.id !== previous.versionId) return done({ status: NEWER_VERSION, latest });
    filedVersion = await versionOf(supabase, previous.versionId);
    if (!filedVersion) return done({ status: "failed", error: `v${previous.versionNumber}, where the review was filed, could not be read` });
    const filedFile = await workingFileOf(supabase, filedVersion);
    const filedRows = await versionRows(supabase, filedVersion.id);
    const mine = new Set(findings.map((f) => f.superseded_by).filter(Boolean));
    priorRows = filedRows.filter((r) => mine.has(r.id));
    // A follow-up's version carries the first filing's changes under new
    // ids, so after one the lawyer leaves findings out by rejecting them in
    // the Changes list instead.
    if (Number(previous.followUps ?? 0) > 0 || filedFile.decided || priorRows.some((r) => stateOf(r) !== "waiting")) return done({ status: "decided_in_filed", filedVersion });
    carry = filedRows.filter((r) => !mine.has(r.id));
    expected = previous.versionId;
  } else {
    if (latest && latest.id !== version.id) return done({ status: NEWER_VERSION, latest });
    carry = await versionRows(supabase, version.id);
  }
  const chosen = findings.filter((f) => !excluded.has(f.id) && f.status === "pending" && (previous || f.placement !== "superseded"));
  const decidedBefore = findings.filter((f) => !excluded.has(f.id) && !chosen.includes(f)).length;
  if (!chosen.length) return done({ status: "nothing_left", excluded: [...excluded], decidedBefore });

  const placedRun = await withPlacement(async () => {
    const file = await workingFileOf(supabase, version);
    const bytes = await downloadFile(supabase, file);
    const outcome = await placeRows({
      supabase, base: version, doc, file, bytes, chosen, carry, expectedLatestId: expected, userId, save,
      label: label ?? reviewLabel(null, at), isAiGenerated, apply, format, log, shouldStop,
    });
    outcome.excluded = [...excluded];
    outcome.decidedBefore = decidedBefore;
    if (outcome.status === NEWER_VERSION && !outcome.latest) outcome.latest = await latestVersionOf(supabase, version.matter_document_id).catch(() => null);
    if (outcome.status === FILED) {
      const n = outcome.saved.versionNumber;
      const patches = [];
      for (const p of outcome.placed) patches.push({ id: p.finding.id, patch: { placement: "superseded", placement_reason: placedNote(n), superseded_by: p.rowId } });
      for (const x of outcome.notPlaced) patches.push({ id: x.finding.id, patch: { placement: "unplaced", placement_reason: x.reason, superseded_by: null } });
      if (excluded.size) {
        const iso = at.toISOString();
        for (const id of excluded) patches.push({ id, patch: { status: "rejected", decided_by: userId, decided_at: iso } });
      }
      // Re-placing: this review's changes in vF are placed again in the new
      // version, or left out; either way they no longer wait in vF.
      const placedAgain = new Map(outcome.placed.map((p) => [p.finding.superseded_by, p.rowId]));
      for (const r of priorRows) {
        const to = placedAgain.get(r.id) ?? null;
        patches.push({ id: r.id, patch: { placement: "superseded", placement_reason: to ? `Placed again in v${n}; decide it there.` : `Left out when the review was placed again in v${n}.`, superseded_by: to } });
      }
      await patchRows(supabase, patches, log);
      outcome.extra = previous ? { replacedVersionId: previous.versionId, replacedVersionNumber: previous.versionNumber } : undefined;
      return done(outcome, { record: true });
    }
    if (outcome.status === "none_placed" && !previous) {
      await patchRows(supabase, outcome.notPlaced.map((x) => ({ id: x.finding.id, patch: { placement: "unplaced", placement_reason: x.reason } })), log);
    }
    return done(outcome);
  }, { wait });
  return placedRun.status === "busy" && !placedRun.run ? { ...ctx, previous, status: "busy" } : placedRun;
}

/**
 * A follow-up's corrections (finding rows already recorded against the
 * reviewed version, with ids) placed as a further version of the filed one:
 * the filed version must still be the newest; its waiting changes are
 * carried forward. The run's filing record then points at the new version,
 * which carries everything still waiting. Returns { status, ... } as
 * fileReviewRun does; only a success is recorded.
 */
export async function fileFollowUp({ supabase, runId, rows, userId, save, label = null, isAiGenerated = true, apply = applyReviewSuggestions, format = checkFormat, now = () => new Date(), log = () => {} }) {
  const run = await readRun(supabase, runId);
  const previous = filingOf(run);
  if (!run || previous?.status !== FILED) return { status: "not_filed", run };
  const filed = await versionOf(supabase, previous.versionId);
  if (!filed) return { status: "failed", error: "the version the review was filed as could not be read", run };
  const doc = filed.matter_document;
  const latest = await latestVersionOf(supabase, doc.id);
  if (!latest || latest.id !== filed.id) return { status: NEWER_VERSION, latest, filed, run };
  if (!rows?.length) return { status: "nothing_left", filed, run };
  const at = now();
  return withPlacement(async () => {
    const file = await workingFileOf(supabase, filed);
    const bytes = await downloadFile(supabase, file);
    const carry = await versionRows(supabase, filed.id);
    const outcome = await placeRows({
      supabase, base: filed, doc, file, bytes, chosen: rows, carry, expectedLatestId: filed.id, userId, save,
      label: label ?? reviewLabel(null, at, "Review follow-up placed"), isAiGenerated, apply, format, log, shouldStop: () => false,
    });
    if (outcome.status === FILED) {
      const n = outcome.saved.versionNumber;
      await patchRows(supabase, [
        ...outcome.placed.map((p) => ({ id: p.finding.id, patch: { placement: "superseded", placement_reason: placedNote(n), superseded_by: p.rowId } })),
        ...outcome.notPlaced.map((x) => ({ id: x.finding.id, patch: { placement: "unplaced", placement_reason: x.reason } })),
      ], log);
      const filing = {
        ...previous, at: at.toISOString(), by: userId ?? null,
        versionId: outcome.saved.versionId, versionNumber: n, fileName: outcome.saved.fileName ?? null, label: outcome.saved.label ?? null,
        placed: Number(previous.placed ?? 0) + outcome.placed.length, waiting: outcome.waiting,
        notPlaced: [...(previous.notPlaced ?? []), ...outcome.notPlaced.map((x) => ({ suggestionId: x.finding.id, reason: x.reason }))],
        followUps: Number(previous.followUps ?? 0) + 1,
      };
      outcome.filing = filing;
      outcome.recorded = await recordFiling(supabase, run.id, filing, log);
    } else if (outcome.status === "none_placed") {
      await patchRows(supabase, outcome.notPlaced.map((x) => ({ id: x.finding.id, patch: { placement: "unplaced", placement_reason: x.reason } })), log);
    }
    return { ...outcome, run, filed, doc };
  });
}

// ---------------------------------------------------------------- what the Hub says

/** A filing's outcome in a few fields, for the Hub's POST /review answer (no document text). */
export function filingSummary(out) {
  if (!out) return null;
  return {
    status: out.status,
    versionId: out.saved?.versionId ?? null,
    versionNumber: out.saved?.versionNumber ?? null,
    placed: out.placed?.length ?? 0,
    waiting: out.waiting ?? 0,
    notPlaced: out.notPlaced?.length ?? 0,
    latestVersionId: out.latest?.id ?? null,
    latestVersionNumber: out.latest?.version_number ?? null,
    note: out.error ?? (out.status === "format_refused" ? out.format?.text ?? null : null),
  };
}

/**
 * The lines a Hub chat reply ends with after a review was filed or not:
 * where the changes wait and what could not be placed, or why nothing was
 * filed. `beside` says the version is open beside the reply. Empty when
 * there is nothing to say (no findings, a PDF, filing off).
 */
export function filingReplyText(out, { title = "the document", beside = true } = {}) {
  if (!out) return "";
  const where = beside ? ", open beside this reply" : "";
  if (out.status === FILED) {
    const n = out.saved.versionNumber;
    const k = out.waiting ?? out.placed.length;
    const lines = [`Filed as v${n} of "${title}": ${k} change${k === 1 ? " is" : "s are"} waiting for you in its Changes list${where}. Accept or reject each there; nothing else needs doing.`];
    if (out.notPlaced?.length) {
      lines.push("", `Could not be placed (${out.notPlaced.length}):`);
      for (const x of out.notPlaced.slice(0, 40)) lines.push(`- ${x.finding?.clause_reference ? oneLine(x.finding.clause_reference) : "A finding"} — ${placementNote(x.reason) ?? x.reason}`);
      if (out.notPlaced.length > 40) lines.push(`- and ${out.notPlaced.length - 40} more`);
    }
    if (out.rowsError) lines.push("", `The changes are in the file, but the Hub could not list them in v${n}'s Changes list (${out.rowsError}); decide them in Word, and tell the Hub's owner.`);
    if (out.format && out.format.result?.status !== "matches") lines.push("", out.format.text);
    return lines.join("\n");
  }
  if (out.status === NEWER_VERSION) {
    const latest = out.latest?.version_number ? `v${out.latest.version_number}` : "A newer version";
    const reviewed = out.version?.version_number ?? out.filed?.version_number;
    return `Not filed: ${latest} of "${title}" was saved while the review ran, and the findings quote v${reviewed ?? "?"}'s words, so nothing was placed over it. They are listed${beside ? " beside this reply" : ""} for reading; ask for a fresh review of the newest version to have one filed.`;
  }
  if (out.status === "none_placed") return `Not filed: none of the findings' quoted wording could be found once in the file, so no new version was made.${beside ? " Each finding beside this reply says why." : ""}`;
  if (out.status === "format_refused") return out.format?.text ?? "Not filed: the format check refused the marked-up file.";
  if (out.status === "failed") return `The findings could not be filed as the next version (${out.error ?? "no reason was given"}).${beside ? " They are listed beside this reply." : ""}`;
  return "";
}
