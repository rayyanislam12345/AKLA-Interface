// The Changes list of a stored project version.
//
// A chat's AI changes belong to its working document (ai_artifacts) and are
// decided in a new copy of the file each time (server.js decideChanges). The
// claude.ai connector's mark-up (connector/tools/markup.js,
// apply_tracked_changes) has no chat: it files the client's draft with
// "AKLA AI"'s tracked changes as the next version of the same project
// document, and records one redline_suggestions row per change anchored to
// that version (document_version_id set, artifact_id and thread_id null,
// review_type 'edit', the Word revision ids each change minted). This module
// is that version's Changes list: the rows, the file they are decided in,
// and the decision itself, with the same cards, counts, sentences and
// all-or-nothing rule per change as a chat's (changes.js).
//
// The version's own file is the firm's record and is never rewritten. A
// decision writes the decided file beside it in the matter-documents bucket
// (<matter>/<document>/<version>/changes/...) and points the version's row
// in version_change_heads at it (migration 20261020130000), guarded by the
// path it expects to replace, so two decisions cannot both land on one
// file. The head is what the Changes list counts against, what the Hub's
// download and a clean copy read, and what a further mark-up of the same
// version starts from; until the first decision it is the version's own
// file. Decisions on one version run one after another in this process
// (changes.js withDocumentLock, keyed "version:<id>").
//
// Shared by chat-service (server.js: /changes/list, /changes/decide and
// /documents/file with { versionId }) and the connector (markup.js), which
// run as two processes over the same tables; every function takes the
// service-role client. Node 20.
import { randomUUID } from "node:crypto";
import {
  applyDecisions, findRevisions, reconcile, stateOf, cardsFor, countsWith, editRecords,
  notDoneFor, undecidable, withDocumentLock, CHANGED_WHILE_DECIDING, NO_CHANGES_YET,
} from "./changes.js";

export const VERSION_BUCKET = "matter-documents";
export const HEADS_TABLE = "version_change_heads";
/** The review_type of a version's change rows: the mark-up is an edit, as the Hub's own Edit turn's rows are. */
export const VERSION_ROW_TYPE = "edit";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const NOT_WORD_SENTENCE = "Only a Word version has tracked changes to decide.";
// PostgREST's and Postgres's words for a table that is not there.
const MISSING_TABLE = /PGRST205|42P01|does not exist|schema cache/i;

/** The lock a version's decisions (and anything that moves its head) are taken under. */
export const versionLockKey = (versionId) => `version:${versionId}`;
export const isWordPath = (path) => /\.docx$/i.test(String(path ?? ""));

/**
 * The version with its document: { id, version_number, storage_path,
 * file_name, label, created_at, matter_document_id, matter_document: { id,
 * title, matter_id, document_type_id } }, or null.
 */
export async function versionOf(db, versionId) {
  const { data, error } = await db
    .from("document_versions")
    .select("id, version_number, storage_path, file_name, label, created_at, matter_document_id, matter_document:matter_documents(id, title, matter_id, document_type_id)")
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the version: ${error.message}`);
  return data && data.matter_document ? data : null;
}

/** The newest version of a document: { id, version_number } or null. */
export async function latestVersionOf(db, matterDocumentId) {
  const { data, error } = await db.from("document_versions").select("id, version_number").eq("matter_document_id", matterDocumentId).order("version_number", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Could not read the document's versions: ${error.message}`);
  return data ?? null;
}

/**
 * The file a version's changes are decided in: the decided copy its
 * version_change_heads row names, or the version's own file before any
 * decision. { bucket, storagePath, fileName, decided, updatedAt, updatedBy }.
 */
export async function workingFileOf(db, version) {
  const { data, error } = await db.from(HEADS_TABLE).select("document_version_id, storage_path, file_name, updated_at, updated_by").eq("document_version_id", version.id).maybeSingle();
  // Before migration 20261020130000 the table is missing, and no decision
  // can have been kept: the version's own file is the working file. Only a
  // decision (writeVersionHead) needs the table.
  if (error && !MISSING_TABLE.test(`${error.code ?? ""} ${error.message ?? ""}`)) throw new Error(`Could not read where this version's decisions are kept: ${error.message}`);
  const own = version.file_name ?? String(version.storage_path).split("/").pop();
  if (data?.storage_path) return { bucket: VERSION_BUCKET, storagePath: data.storage_path, fileName: data.file_name ?? own, decided: true, updatedAt: data.updated_at ?? null, updatedBy: data.updated_by ?? null };
  return { bucket: VERSION_BUCKET, storagePath: version.storage_path, fileName: own, decided: false, updatedAt: version.created_at ?? null, updatedBy: null };
}

export async function downloadFile(db, file) {
  const { data: blob, error } = await db.storage.from(file.bucket).download(file.storagePath);
  if (error || !blob) throw new Error(`Could not read ${file.fileName ?? "the document"}: ${error?.message ?? "download failed"}`);
  return blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());
}

/**
 * The version's change rows, oldest first: the ones that carry Word
 * revision ids (review_type 'edit', no chat). A legacy review's
 * suggestions on the same version (text-matched, by review run) are not
 * part of this list; the review panel keeps showing those.
 */
export async function versionRows(db, versionId) {
  const { data, error } = await db
    .from("redline_suggestions")
    .select("*")
    .eq("document_version_id", versionId)
    .is("artifact_id", null)
    .eq("review_type", VERSION_ROW_TYPE)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load the changes: ${error.message}`);
  return data ?? [];
}

/**
 * The highest revision id ever recorded for any version of a document: a
 * mark-up mints ids above it (docxAgent applyDocxOps idFloor), so an id
 * decided away in one version is never handed out again in the next.
 */
export async function highestRecordedVersionId(db, matterDocumentId) {
  const { data: versions, error } = await db.from("document_versions").select("id").eq("matter_document_id", matterDocumentId);
  if (error) throw new Error(`Could not read the document's versions: ${error.message}`);
  const ids = (versions ?? []).map((v) => v.id);
  if (!ids.length) return 0;
  const { data: rows, error: rowsError } = await db.from("redline_suggestions").select("revision_ids").in("document_version_id", ids);
  if (rowsError) throw new Error(`Could not read the document's changes: ${rowsError.message}`);
  let max = 0;
  for (const row of rows ?? []) for (const id of row.revision_ids ?? []) max = Math.max(max, Number(id) || 0);
  return max;
}

/** Who decided each change, by name, in one lookup. */
async function namesOf(db, rows) {
  const ids = [...new Set(rows.map((r) => r.decided_by).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data } = await db.from("profiles").select("id, full_name").in("id", ids);
  return new Map((data ?? []).map((p) => [p.id, p.full_name ?? null]));
}

/** The head as the panel reads it (server.js headSummary's shape, plus the version). */
export const versionHeadSummary = (version, file) => ({
  id: version.id,
  versionId: version.id,
  versionNumber: version.version_number,
  bucket: file.bucket,
  storagePath: file.storagePath,
  fileName: file.fileName,
  title: version.matter_document?.title ?? null,
  updatedAt: file.updatedAt,
  decided: file.decided,
});

/**
 * The list as the panel shows it: every card of the version, numbered in
 * the order the changes were made, or only the named ones; the counts from
 * the rows and the file (other people's revisions, AI ones no row names).
 */
export async function versionChangesBody(db, { version, file, bytes, only = null, rows = null }) {
  const all = rows ?? (await versionRows(db, version.id));
  const cards = cardsFor(all, await namesOf(db, all));
  return {
    workingDocumentId: null,
    versionId: version.id,
    head: versionHeadSummary(version, file),
    changes: only ? cards.filter((c) => only.has(c.id)) : cards,
    counts: countsWith(all, findRevisions(bytes)),
  };
}

/** /changes/list for a version: { status, body }. */
export async function listVersionChanges(db, versionId) {
  const version = await versionOf(db, versionId);
  if (!version) return { status: 404, body: { error: "Document not found" } };
  const file = await workingFileOf(db, version);
  if (!isWordPath(version.storage_path)) {
    return { status: 200, body: { workingDocumentId: null, versionId: version.id, head: versionHeadSummary(version, file), changes: [], counts: countsWith([], { ours: new Set(), others: 0 }) } };
  }
  return { status: 200, body: await versionChangesBody(db, { version, file, bytes: await downloadFile(db, file) }) };
}

/**
 * Points the version at a newly decided file. The upload comes first; the
 * row moves only if it still names the file the decision was made on (or,
 * for the first decision, if no row exists yet), so a lost race leaves the
 * row as the other decision wrote it and returns { conflict: true }.
 */
export async function writeVersionHead(db, { version, file, bytes, userId, now = new Date().toISOString() }) {
  const safeName = String(file.fileName ?? "document.docx").replace(/[^\w.-]+/g, "-");
  const md = version.matter_document;
  const storagePath = `${md.matter_id}/${md.id}/${version.id}/changes/${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;
  const { error: upErr } = await db.storage.from(VERSION_BUCKET).upload(storagePath, bytes, { contentType: DOCX_MIME, upsert: false });
  if (upErr) throw new Error(`Could not save the decided file: ${upErr.message}`);
  const row = { document_version_id: version.id, storage_path: storagePath, file_name: file.fileName ?? null, updated_by: userId ?? null, updated_at: now };
  if (file.decided) {
    const { data, error } = await db.from(HEADS_TABLE).update(row).eq("document_version_id", version.id).eq("storage_path", file.storagePath).select("document_version_id");
    if (error) throw new Error(`Could not record the decided file: ${error.message}`);
    if (!data?.length) return { conflict: true, storagePath };
  } else {
    const { error } = await db.from(HEADS_TABLE).insert(row);
    // A row that appeared meanwhile (the primary key) is another decision's.
    if (error) {
      if (error.code === "23505" || /duplicate key/i.test(error.message ?? "")) return { conflict: true, storagePath };
      throw new Error(`Could not record the decided file: ${error.message}`);
    }
  }
  return { file: { bucket: VERSION_BUCKET, storagePath, fileName: file.fileName, decided: true, updatedAt: now, updatedBy: userId ?? null } };
}

/**
 * /changes/decide for a version: accepts or rejects the named changes in
 * the version's working file, under the version's lock. The same rules as
 * a chat's (server.js decideChanges): a change not waiting, gone from the
 * file, or one Word has to decide is reported in notDone and left alone;
 * the rest are decided together in one new file; nothing is written when
 * the file fails its checks or another decision moved the head meanwhile.
 * decisions: [{ changeId, decision }], already validated. Returns { status, body }.
 */
export function decideVersionChanges(db, { versionId, decisions, userId }) {
  return withDocumentLock(versionLockKey(versionId), async () => {
    const version = await versionOf(db, versionId);
    if (!version) return { status: 404, body: { error: "Document not found" } };
    if (!isWordPath(version.storage_path)) return { status: 409, body: { error: NOT_WORD_SENTENCE } };
    const rows = await versionRows(db, version.id);
    if (!rows.length) return { status: 409, body: { error: NO_CHANGES_YET } };
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (decisions.some((d) => !byId.has(d.changeId))) return { status: 400, body: { error: "One of the changes is not in this document." } };
    const notDone = [];
    const items = [];
    for (const d of decisions) {
      const row = byId.get(d.changeId);
      if (stateOf(row) === "waiting") items.push({ id: row.id, part: row.part, revisionIds: row.revision_ids, decision: d.decision });
      else notDone.push(notDoneFor(row));
    }

    const file = await workingFileOf(db, version);
    const bytes = await downloadFile(db, file);
    let out;
    try {
      out = applyDecisions(bytes, items);
    } catch (err) {
      return { status: 422, body: { error: err.message } };
    }
    const applied = items.filter((it, i) => out.results[i].status === "applied");
    const refused = out.results.filter((r) => r.status !== "applied").map(undecidable);
    for (const r of refused) notDone.push(r.notDone);

    // The head moves before any row changes, so a lost race leaves the rows
    // as they were; only the uploaded file is orphaned.
    const now = new Date().toISOString();
    const written = applied.length ? await writeVersionHead(db, { version, file, bytes: out.bytes, userId, now }) : null;
    if (written?.conflict) {
      await db.storage.from(VERSION_BUCKET).remove([written.storagePath]).catch(() => {});
      return { status: 409, body: { error: CHANGED_WHILE_DECIDING } };
    }

    for (const r of refused) await db.from("redline_suggestions").update(r.patch).eq("id", r.notDone.changeId);
    for (const decision of ["accepted", "rejected"]) {
      const ids = applied.filter((it) => it.decision === decision).map((it) => it.id);
      // decided_by is passed explicitly: the service role has no auth.uid().
      if (ids.length) await db.from("redline_suggestions").update({ status: decision, decided_by: userId, decided_at: now }).in("id", ids);
    }
    if (applied.length) {
      const touched = new Set(items.map((it) => it.id));
      for (const { id, patch } of reconcile(out.bytes, rows.filter((r) => !touched.has(r.id)), [])) await db.from("redline_suggestions").update(patch).eq("id", id);
    }

    const head = written?.file ?? file;
    const body = await versionChangesBody(db, { version, file: head, bytes: applied.length ? out.bytes : bytes, only: new Set(decisions.map((d) => d.changeId)) });
    return { status: 200, body: { ...body, notDone } };
  });
}

// ---------------------------------------------------------------- mark-up rows

/**
 * The rows for a mark-up's results, anchored to the version it was filed
 * as: changes.js editRecords (one per text-changing operation; comments
 * have none, a withdrawal of the AI's own earlier insertion none either),
 * then moved off the chat (artifact_id and thread_id null) onto the
 * version, each with an id minted here so what the database confirms is
 * matched by id. Returns { rows, withdrawals }.
 */
export function versionEditRows(results, { versionId, userId }) {
  const { rows, withdrawals } = editRecords(results.filter((r) => String(r.kind ?? "").toLowerCase() !== "comment"), { threadId: null, rootId: null, userId });
  for (const row of rows) {
    row.id = randomUUID();
    row.document_version_id = versionId;
    row.artifact_id = null;
    row.thread_id = null;
    row.review_type = VERSION_ROW_TYPE;
  }
  return { rows, withdrawals };
}

/**
 * A further mark-up of a version whose own changes are still waiting: the
 * new file carries those revisions with their ids, so each waiting row is
 * copied onto the new version (the same change, the same ids, still
 * waiting) and the old row is marked as carried forward, so the old
 * version's list says where it went instead of offering a decision in a
 * file nobody is working on. Decided, unplaced and replaced rows stay
 * where they are: they describe the old version. Returns { clones,
 * carried: [{ id, patch }] } for the caller to write.
 */
export function carryForward(rows, { toVersionId, toVersionNumber }) {
  const clones = [];
  const carried = [];
  for (const row of rows) {
    if (stateOf(row) !== "waiting") continue;
    const id = randomUUID();
    // created_at is kept, so the new list numbers the carried changes
    // before the ones the new mark-up adds, in the order they were made.
    const { id: _old, decided_at: _d, decided_by: _b, superseded_by: _s, ...rest } = row;
    clones.push({ ...rest, id, document_version_id: toVersionId, artifact_id: null, thread_id: null, status: "pending", decided_by: null, decided_at: null, superseded_by: null });
    carried.push({ id: row.id, patch: { placement: "superseded", placement_reason: `Carried forward to v${toVersionNumber}, where it can be decided.`, superseded_by: id } });
  }
  return { clones, carried };
}
