// The write foundation of the connector: the one way a tool saves a new
// version of a document into a project, the record of every write, and the
// caps. Every write tool (connector/tools/README.md) goes through the three
// functions here, in this order: checkCaps (which also re-checks the
// sign-in afresh), the work, recordAction.
//
// A save is the site's own save (src/lib/saveDraftToMatter.ts and
// src/lib/saveFileToProject.ts), done from the server as the signed-in
// lawyer: the file is uploaded to the matter-documents bucket under the same
// path shape the site uses, then save_document_version_as (migration
// 20261020120000_connector_writes.sql: the site's save_document_version with
// the user id as a parameter, since auth.uid() is null under the service
// role) allocates the version number under the document's lock and refuses
// a save over a stale version. The AFTER INSERT trigger on document_versions
// (20261017090000_indexing_pipeline.sql, document_versions_enqueue_index)
// queues the index worker, so nothing here asks for indexing. If the
// function fails, the uploaded object is removed again unless a version row
// already holds it (a lost response after a committed save).
//
// The owner's decisions (docs/connector-expansion-plan-2026-10-19.md):
// a deliberate save from claude.ai is the lawyer's own filing, so the
// version is written with is_ai_generated = false (the Hub's meaning search
// then finds it) and its label says it came from claude.ai; any firm member
// may save into any project; the record never holds document text; 30
// writes an hour and 200 a day per person, counted from the record so a
// restart does not reset them (only the rows that changed something: a
// refused or failed attempt is on the record but is not a write); no
// delete anywhere; Hub links, never signed storage links. The VM runs Node
// 20: nothing newer is used.
//
// The record is written after the work, and claude.ai sends several tool
// calls in one turn while the connector serves requests side by side, so
// the writes this process has begun but not yet recorded are counted too
// (one in-flight entry per checkCaps, released by the handle it returns or
// after IN_FLIGHT_MS, whichever is first). Two writes started together at
// the 29th row then see each other: the first to count passes, the other
// is refused.

import { randomUUID } from "node:crypto";
import { READ_ONLY_REFUSAL, READ_SCOPE, WRITE_SCOPE, hasScope } from "./oauth.js";
import { DEFAULT_HUB_URL, hubBase, hubLink } from "./hubLinks.js";

export const BUCKET = "matter-documents";
export const HOURLY_CAP = 30;
export const DAILY_CAP = 200;
export const MAX_WRITE_BYTES = 25_000_000;
/** Supabase Storage's per-file limit on this project (50 MiB): no save may pass it, whatever maxBytes says. */
export const MAX_STORED_BYTES = 50 * 1024 * 1024;
export const MAX_TITLE_CHARS = 200;
export const MAX_LABEL_CHARS = 200;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How long a write begun here counts toward the caps if its handle is never released (a 60 s render plus an upload is well inside it). */
export const IN_FLIGHT_MS = 5 * 60 * 1000;
/** The outcomes that changed something on the Hub: the only rows the caps count. */
const COUNTED_OUTCOMES = Object.freeze(["saved", "done"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// What save_document_version_as accepts as an extension and a stem.
const EXTENSION_RE = /^[a-zA-Z0-9]{1,10}$/;
const MIME_BY_EXTENSION = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
// The columns a record may carry. Nothing else is written: a builder who
// passes the document's text by mistake gets an error, not a row.
const ACTION_FIELDS = Object.freeze(["tool", "projectId", "documentId", "versionId", "label", "outcome"]);
const OUTCOMES = new Set(["saved", "done", "failed", "refused"]);

export const SIGN_IN_ENDED_SENTENCE = "Your sign-in to the Hub has ended or was withdrawn; reconnect the AKLA Hub connector in claude.ai before saving.";

const uuid = (v) => (typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Karachi" });

/**
 * The site's storage-key rule (src/lib/utils.ts sanitizeStorageFilename):
 * Supabase Storage rejects parentheses, ampersands, apostrophes and
 * non-Latin script in a key with an unexplained "Invalid path", so the key
 * is reduced to word characters, dots and hyphens. The display name is the
 * database's file_name, which the save function composes from the stem.
 */
export function sanitizeStorageFilename(name) {
  const s = String(name ?? "");
  const lastDot = s.lastIndexOf(".");
  const base = lastDot > 0 ? s.slice(0, lastDot) : s;
  const ext = lastDot > 0 ? s.slice(lastDot) : "";
  const safeBase = base.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const safeExt = ext.replace(/[^\w.]+/g, "");
  return (safeBase || "file") + safeExt;
}

/** The file-name stem a version is stored under (src/lib/saveDraftToMatter.ts storageStem); the database adds "-v<n>.<ext>". */
export function storageStem(text) {
  return sanitizeStorageFilename(String(text ?? "").replace(/[^\w\s-]+/g, " ").trim().replace(/[\s-]+/g, "-")).slice(0, 180) || "Document";
}

/** "report.md" -> { stem: "report", extension: "md" }; a name without an extension throws. */
export function splitFileName(fileName) {
  const name = String(fileName ?? "").trim();
  const m = /^(.*)\.([A-Za-z0-9]{1,10})$/.exec(name);
  if (!m || !m[1].trim()) throw new Error("fileName needs a name and an extension, like \"Notes on the term sheet.md\".");
  const extension = m[2].toLowerCase();
  if (!EXTENSION_RE.test(extension)) throw new Error("The file extension must be letters and digits only.");
  return { stem: storageStem(m[1]), extension };
}

/**
 * The label a saved version carries: the lawyer's own with the source
 * added, or "Saved from claude.ai — 19 October 2026". Decision 1: the
 * version is the lawyer's filing, and the label says where it came from.
 */
export function versionLabel(label, at = new Date()) {
  const own = String(label ?? "").replace(/\s+/g, " ").trim();
  const suffix = " — saved from claude.ai";
  if (own) return own.length + suffix.length > MAX_LABEL_CHARS ? `${own.slice(0, MAX_LABEL_CHARS - suffix.length - 1)}…${suffix}` : `${own}${suffix}`;
  return `Saved from claude.ai — ${dateFmt.format(at)}`;
}

/** The one-sentence refusal the database's reasons become. */
function saveFailure(message) {
  const msg = String(message ?? "");
  if (/newer document version exists/i.test(msg)) return "A newer version exists: a colleague saved one in the meantime, so read the latest version (list_project_documents) before saving again.";
  if (/Forbidden/i.test(msg)) return "Only approved members of the firm can save into a project.";
  if (/Project is unavailable/i.test(msg)) return "That project is no longer available.";
  if (/does not belong to this project/i.test(msg)) return "That document is not on that project.";
  if (/uploaded file is unavailable/i.test(msg)) return "The file did not reach the Hub's storage; try again.";
  return `The Hub could not save the version${msg ? ` (${msg})` : ""}.`;
}

/**
 * @param {object} deps
 * @param {object} deps.supabase   service-role client (storage and the RPC)
 * @param {string} [deps.hubUrl]   the site's address for the links a save returns
 * @param {Function} [deps.now]    () -> Date
 * @param {Function} [deps.log]
 * @returns {{ saveVersion, recordAction, checkCaps }}
 */
export function createProjectWrites({ supabase, hubUrl = DEFAULT_HUB_URL, now = () => new Date(), log = () => {} }) {
  const site = hubBase(hubUrl);
  // The writes begun in this process and not yet released, per person:
  // Map<userId, Map<seq, startedAtMs>>. A write counts the ones begun
  // before it (a lower seq), so of two begun together exactly one passes
  // at the cap.
  const inFlight = new Map();
  let seq = 0;

  /** Begins an in-flight entry for the person; returns its release (idempotent). */
  function begin(userId, at) {
    const mine = inFlight.get(userId) ?? new Map();
    inFlight.set(userId, mine);
    const id = (seq += 1);
    mine.set(id, at);
    return {
      id,
      release() {
        const m = inFlight.get(userId);
        if (!m) return;
        m.delete(id);
        if (!m.size) inFlight.delete(userId);
      },
    };
  }

  /** The person's writes begun before `id` and still in flight (entries past IN_FLIGHT_MS are dropped). */
  function inFlightBefore(userId, id, at) {
    const mine = inFlight.get(userId);
    if (!mine) return 0;
    let n = 0;
    for (const [other, started] of mine) {
      if (at - started > IN_FLIGHT_MS) mine.delete(other);
      else if (other < id) n += 1;
    }
    return n;
  }

  /**
   * The gate every write passes first. Re-checks the sign-in afresh through
   * ctx.recheck (app.js: the token row by its hash, past the minute's
   * cache), then counts this person's writes: the record's rows that
   * changed something (outcome saved or done; a refused or failed attempt
   * is not a write), whatever process wrote them, plus the writes this
   * process has begun and not yet recorded. At most HOURLY_CAP in the last
   * hour and DAILY_CAP in the last day. Refuses with one sentence; returns
   * the counts and `release`, which the tool calls once its record is
   * written (or it gave up), in a finally. An entry never released stops
   * counting after IN_FLIGHT_MS.
   */
  async function checkCaps(ctx) {
    const userId = uuid(ctx?.userId);
    if (!userId) throw new Error(SIGN_IN_ENDED_SENTENCE);
    // Begun before anything is awaited, so two calls side by side each see the other.
    const entry = begin(userId, now().getTime());
    let hour = 0;
    let day = 0;
    try {
      let scope = ctx?.scope ?? READ_SCOPE;
      if (typeof ctx?.recheck === "function") {
        const fresh = await ctx.recheck();
        if (!fresh || fresh.userId !== userId) throw new Error(SIGN_IN_ENDED_SENTENCE);
        scope = fresh.scope;
      }
      if (!hasScope(scope, WRITE_SCOPE)) throw new Error(READ_ONLY_REFUSAL);
      const t = now().getTime();
      // One small query: the day's rows (at most DAILY_CAP + 1, newest first,
      // so the hour's are among them), counted here. The index on
      // (user_id, created_at) serves it; the outcome filter is on those rows.
      const { data, error } = await supabase
        .from("connector_actions")
        .select("created_at")
        .eq("user_id", userId)
        .in("outcome", COUNTED_OUTCOMES)
        .gte("created_at", new Date(t - DAY_MS).toISOString())
        .order("created_at", { ascending: false })
        .limit(DAILY_CAP + 1);
      if (error) throw new Error(`The saving limit could not be checked: ${error.message}`);
      const rows = data ?? [];
      const pending = inFlightBefore(userId, entry.id, t);
      day = rows.length + pending;
      hour = rows.filter((r) => new Date(r.created_at).getTime() > t - HOUR_MS).length + pending;
      if (hour >= HOURLY_CAP) throw new Error(`You have saved ${HOURLY_CAP} times from claude.ai in the last hour, which is the limit; try again in a while, or save from the Hub.`);
      if (day >= DAILY_CAP) throw new Error(`You have saved ${DAILY_CAP} times from claude.ai in the last day, which is the limit; try again tomorrow, or save from the Hub.`);
    } catch (err) {
      entry.release();
      throw err;
    }
    return { hour, day, release: entry.release };
  }

  /**
   * One row in connector_actions for one write: who, which tool, which
   * project, document and version, the label and the outcome ("saved",
   * "done", "failed" or "refused"). Never the document's text: only the
   * fields named in ACTION_FIELDS are accepted, and any other key throws.
   */
  async function recordAction(ctx, action) {
    const userId = uuid(ctx?.userId);
    if (!userId) throw new Error("recordAction needs the signed-in lawyer (ctx.userId).");
    const a = action && typeof action === "object" ? action : {};
    const extra = Object.keys(a).filter((k) => !ACTION_FIELDS.includes(k));
    if (extra.length) throw new Error(`recordAction takes only ${ACTION_FIELDS.join(", ")}; not ${extra.join(", ")}. Never the document's text.`);
    const tool = typeof a.tool === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(a.tool) ? a.tool : null;
    if (!tool) throw new Error("recordAction needs the tool's name.");
    const outcome = a.outcome ?? "saved";
    if (!OUTCOMES.has(outcome)) throw new Error(`recordAction's outcome must be one of ${[...OUTCOMES].join(", ")}.`);
    const row = {
      id: randomUUID(),
      user_id: userId,
      client_id: typeof ctx?.clientId === "string" ? ctx.clientId.slice(0, 200) : null,
      tool,
      project_id: uuid(a.projectId),
      document_id: uuid(a.documentId),
      version_id: uuid(a.versionId),
      label: typeof a.label === "string" && a.label.trim() ? a.label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS) : null,
      outcome,
      created_at: now().toISOString(),
    };
    const { error } = await supabase.from("connector_actions").insert(row);
    if (error) throw new Error(`The write could not be recorded: ${error.message}`);
    log(`connector_actions: ${tool} ${outcome} for ${userId}${row.version_id ? ` version ${row.version_id}` : ""}`);
    return row.id;
  }

  /**
   * Saves `bytes` as a new version: of a new document on the project
   * (`matterDocumentId` absent) or the next version of an existing one. A
   * next version is checked against `expectedVersion` (a version id the
   * caller has read) or, when none is given, the latest version at the
   * moment of saving; the database refuses if someone saved in between.
   * Returns ids, the file name, the label and the Hub links. Does not
   * record the action: the tool does, after this returns or throws.
   */
  async function saveVersion({ ctx, projectId, title, matterDocumentId = null, documentTypeId = null, expectedVersion = null, bytes, fileName, mime = null, label = null, labelVerbatim = null, isAiGenerated = false, storageKeyId = null, maxBytes = MAX_WRITE_BYTES }) {
    const userId = uuid(ctx?.userId);
    if (!userId) throw new Error(SIGN_IN_ENDED_SENTENCE);
    const matterId = uuid(projectId);
    if (!matterId) throw new Error("projectId must be a project id (a UUID). list_projects gives them.");
    const docTitle = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
    if (!docTitle) throw new Error("A title for the document is needed.");
    const body = bytes instanceof Uint8Array ? bytes : typeof bytes === "string" ? Buffer.from(bytes, "utf8") : null;
    if (!body || !body.length) throw new Error("There is nothing to save: the file is empty.");
    // A file the lawyer uploads from claude.ai (connector/uploads.js) may be
    // as large as Storage takes; a document a tool builds stays under 25 MB.
    const limit = Math.min(Number(maxBytes) || MAX_WRITE_BYTES, MAX_STORED_BYTES);
    if (body.length > limit) throw new Error(`The file is larger than the ${Math.round(limit / 1_000_000)} MB a save may be.`);
    const { stem, extension } = splitFileName(fileName);
    const contentType = typeof mime === "string" && mime.trim() ? mime.split(";")[0].trim() : MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
    const docId = matterDocumentId == null ? randomUUID() : uuid(matterDocumentId);
    if (!docId) throw new Error("matterDocumentId must be a document id (a UUID). list_project_documents gives them.");
    const createNew = matterDocumentId == null;
    const expected = expectedVersion == null ? null : uuid(expectedVersion);
    if (expectedVersion != null && !expected) throw new Error("expectedVersion must be a document version id (a UUID).");

    // A next version: the document must be on this project (the function
    // checks too, but with the type id, which is read here), and a stale
    // expected version is refused before anything is uploaded.
    let typeId = documentTypeId == null ? null : uuid(documentTypeId);
    let expectedId = null;
    if (!createNew) {
      const { data: doc, error: docError } = await supabase.from("matter_documents").select("id, title, matter_id, document_type_id").eq("id", docId).maybeSingle();
      if (docError) throw new Error(`Could not read the document: ${docError.message}`);
      if (!doc) throw new Error("There is no project document with that id. list_project_documents gives them.");
      if (doc.matter_id !== matterId) throw new Error("That document is not on that project.");
      typeId = doc.document_type_id ?? null;
      const { data: latest, error: latestError } = await supabase.from("document_versions").select("id, version_number").eq("matter_document_id", docId).order("version_number", { ascending: false }).limit(1).maybeSingle();
      if (latestError) throw new Error(`Could not read the document's versions: ${latestError.message}`);
      if (expected && latest && latest.id !== expected) throw new Error(`A newer version exists (v${latest.version_number}): read it before saving the next one.`);
      expectedId = expected ?? latest?.id ?? null;
    }

    // An upload names its own key id (its uploadId), so get_upload can find
    // the version after a restart; everything else gets a fresh one.
    const keyId = storageKeyId == null ? randomUUID() : uuid(storageKeyId);
    if (!keyId) throw new Error("storageKeyId must be a UUID.");
    const at = now();
    const storagePath = `${matterId}/${docId}/${keyId}-${stem}.${extension}`;
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, body, { contentType, upsert: false });
    if (uploadError) throw new Error(`The file could not be stored${uploadError.message ? ` (${uploadError.message})` : ""}; try again.`);

    // A tool whose label already says where the version came from (3.2:
    // "Drafted from the firm's standard in claude.ai — <date>") passes it
    // as labelVerbatim; otherwise the label is composed here.
    const verbatim = typeof labelVerbatim === "string" ? labelVerbatim.replace(/\s+/g, " ").trim() : "";
    const finalLabel = verbatim ? verbatim.slice(0, MAX_LABEL_CHARS) : versionLabel(label, at);
    const args = {
      p_user_id: userId, p_matter_id: matterId, p_document_type_id: typeId, p_document_id: docId, p_create_new: createNew,
      p_expected_version_id: expectedId, p_title: docTitle, p_storage_path: storagePath, p_file_stem: stem,
      p_is_ai_generated: isAiGenerated === true, p_extension: extension, p_label: finalLabel,
    };
    const { data, error } = await supabase.rpc("save_document_version_as", args);
    let saved = data && typeof data === "object" ? data : null;
    if (error || !saved) {
      // A lost response after a committed save leaves a row holding this
      // path (the function returns it on a retry); otherwise the upload is
      // taken back so no orphan sits in the bucket. If that lookup fails
      // too (the same outage that lost the response), the object stays: a
      // committed version row may already point at it.
      const { data: mine, error: lookupError } = await supabase.from("document_versions").select("id, version_number, file_name").eq("storage_path", storagePath).maybeSingle();
      if (lookupError) {
        log(`saveVersion for ${userId} on ${docId}: the save failed (${error?.message ?? "no result"}) and the lookup after it too (${lookupError.message}); ${storagePath} left in place`);
        throw new Error("The Hub could not confirm whether the version was saved; check the project page before saving again.");
      }
      if (mine) saved = { matterDocumentId: docId, versionId: mine.id, versionNumber: mine.version_number, fileName: mine.file_name };
      else {
        await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
        log(`saveVersion for ${userId} failed on ${docId}: ${error?.message ?? "no result"}`);
        throw new Error(saveFailure(error?.message));
      }
    }
    log(`saveVersion for ${userId}: v${saved.versionNumber} of ${saved.matterDocumentId} on ${matterId} (${body.length} bytes, ${extension})`);
    return {
      matterDocumentId: saved.matterDocumentId,
      versionId: saved.versionId,
      versionNumber: saved.versionNumber,
      fileName: saved.fileName,
      storagePath,
      label: finalLabel,
      created: createNew,
      links: { project: hubLink("project", matterId, site), version: hubLink("version", saved.versionId, site) },
      note: "On file; the Hub is reading it now. Call get_document_summary on the version in about a minute.",
    };
  }

  return { saveVersion, recordAction, checkCaps };
}
