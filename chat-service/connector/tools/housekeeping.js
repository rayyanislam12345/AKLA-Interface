// Small housekeeping a lawyer's claude.ai can do on a project without
// opening the Hub: write the project's standing instructions ("remember for
// this project that the client is the Sindh PPP Unit"), label a version,
// rename a document, move it along its status line, make an empty document
// record for a version to be saved into, or ask the Hub to read a version
// again ("try reading the scanned annex again"). Piece 2.3 of the plan
// (docs/connector-expansion-plan-2026-10-19.md).
//
// Each tool writes exactly what the site's own page writes, through the
// service role as the signed-in lawyer: matter_context (the project page's
// Project Context, src/hooks/useMatterContext.ts: an upsert on matter_id
// with updated_by), document_versions.label (useMatterDocuments.ts
// setVersionLabel), matter_documents.title and .status
// (useUpdateMatterDocument, useSetMatterDocumentStatus), a matter_documents
// row with created_by (useCreateMatterDocument), and the enqueue_index_job
// function (saveDraftToMatter.ts requestIndexing; SECURITY DEFINER, and it
// skips the member check under the service role because the connector has
// already established that the caller is a firm member). A document's type
// is never changed here: the type decides which Word standard a draft
// fills, so that stays a picker on the Hub. Nothing deletes.
//
// Every tool is a write tool (connector/tools/README.md): listed only for a
// sign-in with hub:write, marked WRITE so claude.ai asks first, and run in
// one order: deps.writes.checkCaps (the sign-in afresh, then 30 an hour and
// 200 a day from connector_actions), the reads that find the row, the one
// write, then deps.writes.recordAction with the ids and the outcome ("done",
// "refused" when the Hub said no before anything changed, "failed" when the
// database refused the write) and never the text written, and the caps
// handle released last. A change that landed but could not be recorded is
// still reported as made (as saves.js does), with one line saying so, so
// nobody retries it. A result is one or two sentences and the Hub link for
// what changed. Two or three short queries per call, one after the other
// (the micro instance has about ten connections); no Voyage call.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WRITE } from "../app.js";
import { str, uuid, when, short } from "../tools.js";

/** The document_status enum, in the order the Hub's status line runs (20260820061242_document_types_and_matter_documents.sql). */
export const DOCUMENT_STATUSES = Object.freeze(["not_started", "drafting", "internal_review", "with_counterparty", "negotiation", "finalized", "executed"]);
/** The standing instructions may be this long; get_project_overview shows the first 8,000 characters and the project page the rest. */
export const MAX_INSTRUCTIONS_CHARS = 20_000;
/** A version label (the plan: at most 120). */
export const MAX_LABEL_CHARS = 120;
/** A document title, as the save function caps it. */
export const MAX_TITLE_CHARS = 200;
/** What a new record starts as (the plan: a record made from claude.ai is being drafted). */
export const NEW_RECORD_STATUS = "drafting";
/** The status a lawyer writes, however spelt ("Internal review", "with-counterparty") → the enum value, or null. */
export const statusValue = (s) => { const v = String(s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_"); return DOCUMENT_STATUSES.includes(v) ? v : null; };
const statusWords = (s) => String(s ?? "").replace(/_/g, " ");
/** What a result says when the change landed but connector_actions would not take the row. */
export const UNRECORDED_LINE = "The change was made but could not be recorded; tell the Hub's owner.";

/** The Hub said no before anything changed (not found, not on that project, too long): recorded as "refused", not "failed". */
class Refusal extends Error {}

/** The one-sentence refusal the database's reasons become, for the two functions this module calls. */
function dbFailure(message, what) {
  const msg = String(message ?? "");
  if (/Forbidden/i.test(msg)) return "Only approved members of the firm can change a project on the Hub.";
  if (/Document version is unavailable/i.test(msg)) return "That version's file is not on the Hub any more, so it cannot be read again.";
  if (/violates foreign key|is not present in table/i.test(msg)) return `The Hub refused the ${what}: something it refers to (the project, the type or your account) is not on the Hub.`;
  if (/invalid input value for enum/i.test(msg)) return `The Hub refused the ${what}: that status is not one it knows.`;
  return `The Hub could not ${what}${msg ? ` (${short(msg, 200)})` : ""}.`;
}

export default ({ supabase, helpers, writes, now = () => Date.now(), log = () => {} }) => {
  const { needProject, needVersion, versionName, open } = helpers;
  const nowIso = () => new Date(now()).toISOString();

  /**
   * One housekeeping write, in the order every write tool keeps: the caps
   * (and the sign-in afresh), `prepare` (the reads that find the row and
   * check the input; a throw here is a refusal, nothing changed), `write`
   * (the one statement; a throw is a failure), then the record with the
   * ids `prepare` found, and the caps handle released whatever happened.
   * Returns the text `write` produced; if the record of a change that
   * landed could not be written, the text says so rather than failing
   * (a failure here would invite a retry of a change already made).
   */
  async function perform(ctx, tool, { prepare, write }) {
    const { checkCaps, recordAction } = writes;
    const caps = await checkCaps(ctx);
    try {
      const record = (ids, outcome) => recordAction(ctx, { tool, ...ids, outcome });
      let found;
      try { found = await prepare(); } catch (err) {
        await record({}, "refused").catch(() => {});
        throw err;
      }
      const ids = found.ids ?? {};
      let text;
      try { text = await write(found); } catch (err) {
        await record(ids, err instanceof Refusal ? "refused" : "failed").catch(() => {});
        throw err;
      }
      try {
        await record({ ...ids, ...(found.after ?? {}) }, "done");
      } catch (err) {
        log(`${tool}: the change was made but the record could not be written: ${err?.message ?? err}`);
        text = `${text}\n${UNRECORDED_LINE}`;
      }
      return text;
    } finally {
      caps.release();
    }
  }

  /** The signed-in lawyer's id as the row's author; checkCaps has already made sure of it. */
  const author = (ctx) => { const id = uuid(ctx?.userId); if (!id) throw new Refusal("Your sign-in to the Hub has ended; reconnect the AKLA Hub connector in claude.ai."); return id; };

  /**
   * A document by its own id, or by the id of any of its versions (what
   * list_project_documents and get_project_overview print), with its
   * project and its latest version for the link.
   */
  async function needDocument(input) {
    const docId = uuid(input.documentId);
    const verId = uuid(input.versionId);
    if (!docId && !verId) throw new Refusal("Give the document's id (documentId, from find_document_by_title) or the id of one of its versions (versionId, from list_project_documents).");
    let id = docId;
    if (!id) {
      const v = await needVersion({ versionId: verId }, "id");
      id = v.matter_document.id;
    }
    const { data, error } = await supabase
      .from("matter_documents")
      .select("id, title, status, matter_id, document_type_id, document_type:document_types(name), matter:matters(id, name), versions:document_versions(id, version_number)")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`Could not read the document: ${error.message}`);
    if (!data || !data.matter) throw new Refusal("There is no project document with that id. find_document_by_title or list_project_documents gives them.");
    let latest = null;
    for (const v of data.versions ?? []) if (!latest || (v.version_number ?? 0) > (latest.version_number ?? 0)) latest = v;
    return { ...data, latest };
  }

  /** The Hub page for a document: its latest version when it has one, else its project. */
  const documentLink = (doc) => (doc.latest ? open("version", doc.latest.id) : open("project", doc.matter_id));

  const describe = (doc) => `${doc.title}${doc.document_type?.name ? ` (${doc.document_type.name})` : ""} on ${doc.matter?.name ?? "the project"}`;

  return [
    {
      name: "set_project_instructions",
      title: "Set a project's standing instructions",
      description: `Write the standing instructions the Hub keeps for a project: the facts and wishes every Hub chat, every claude.ai overview (get_project_overview) and every draft for that project should follow, e.g. "The client is the Sindh PPP Unit; notices go to its Director (Legal); the term is 30 years; use the 2024 NHA model agreement." Use it when the lawyer says "remember for this project that…" or asks you to record what has been settled. It REPLACES the whole text: read the current instructions with get_project_overview first and include what should stay, then give the complete new text (up to ${MAX_INSTRUCTIONS_CHARS.toLocaleString("en")} characters; plain text, a few short paragraphs). The lawyer is asked before it is written; the Hub records who wrote it and when. It changes nothing else about the project and cannot be used to clear the instructions (do that on the Hub).`,
      inputSchema: {
        projectId: z.string().describe("The project's id, from list_projects or find_document_by_title."),
        content: z.string().describe("The complete standing instructions, as they should read from now on."),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        return perform(ctx, "set_project_instructions", {
          async prepare() {
            const content = String(input.content ?? "").replace(/\r\n?/g, "\n").trim();
            if (!content) throw new Refusal("There is nothing to write: give the instructions' complete text (this tool cannot clear them).");
            if (content.length > MAX_INSTRUCTIONS_CHARS) throw new Refusal(`The instructions are ${content.length.toLocaleString("en")} characters; the Hub keeps at most ${MAX_INSTRUCTIONS_CHARS.toLocaleString("en")}. Shorten them.`);
            const matter = await needProject(input);
            const { data: before, error } = await supabase.from("matter_context").select("content, updated_at").eq("matter_id", matter.id).maybeSingle();
            if (error) throw new Error(`Could not read the project's standing instructions: ${error.message}`);
            return { matter, content, before, ids: { projectId: matter.id } };
          },
          async write({ matter, content, before }) {
            const row = { matter_id: matter.id, content, updated_by: author(ctx), updated_at: nowIso() };
            const { error } = await supabase.from("matter_context").upsert(row, { onConflict: "matter_id" });
            if (error) throw new Error(dbFailure(error.message, "write the instructions"));
            const had = String(before?.content ?? "").trim();
            const replaced = had ? `; they replace the ${had.length.toLocaleString("en")}-character instructions${before?.updated_at ? ` written ${when(before.updated_at)}` : ""}` : "; the project had none before";
            return `The standing instructions for ${matter.name} are set (${content.length.toLocaleString("en")} characters${replaced}). Every Hub chat and claude.ai overview of the project now sees them.\n${open("project", matter.id)}`;
          },
        });
      },
    },
    {
      name: "label_version",
      title: "Label a document version",
      description: `Give one version of a project document a short label the Hub shows beside it in the document list (e.g. "Client's mark-up of 12 Oct", "Signed copy", "Sent to SECP"), so colleagues can tell the versions apart. Use it when the lawyer asks to mark, tag or name a version. It replaces any label the version already has (the reply says what it was); it never changes the file, the version number or anything else. Up to ${MAX_LABEL_CHARS} characters. The lawyer is asked before it is written.`,
      inputSchema: {
        versionId: z.string().describe("The document version's id, from list_project_documents or get_project_overview."),
        label: z.string().describe(`The label, up to ${MAX_LABEL_CHARS} characters.`),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        return perform(ctx, "label_version", {
          async prepare() {
            const label = String(input.label ?? "").replace(/\s+/g, " ").trim();
            if (!label) throw new Refusal("A label is needed (this tool cannot clear one; do that on the Hub).");
            if (label.length > MAX_LABEL_CHARS) throw new Refusal(`A label is at most ${MAX_LABEL_CHARS} characters; this one is ${label.length}.`);
            const v = await needVersion(input, "id, version_number, file_name, label");
            return { v, label, ids: { projectId: v.matter_document.matter.id, documentId: v.matter_document.id, versionId: v.id, label } };
          },
          async write({ v, label }) {
            const was = String(v.label ?? "").trim();
            const { error } = await supabase.from("document_versions").update({ label }).eq("id", v.id);
            if (error) throw new Error(dbFailure(error.message, "label the version"));
            return `${versionName(v)} on ${v.matter_document.matter.name} is labelled "${label}"${was ? ` (it was "${short(was, 120)}")` : ""}.\n${open("version", v.id)}`;
          },
        });
      },
    },
    {
      name: "rename_document",
      title: "Rename a document",
      description: `Change the title of a project document on the Hub, the name it is listed under (e.g. from "Draft CA" to "Concession Agreement — Hyderabad bypass"). Use it when the lawyer asks to rename or retitle a document. Give the document's id (documentId, from find_document_by_title) or the id of any of its versions (versionId). It changes the title only: the document's type, status, versions and files stay as they are (a document's type is changed on the Hub, where the Word standard for it is chosen). Up to ${MAX_TITLE_CHARS} characters. The lawyer is asked before it is written.`,
      inputSchema: {
        documentId: z.string().optional().describe("The document's id (documentId in find_document_by_title). Give this or versionId."),
        versionId: z.string().optional().describe("Or the id of any version of the document, from list_project_documents."),
        title: z.string().describe(`The new title, up to ${MAX_TITLE_CHARS} characters.`),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        return perform(ctx, "rename_document", {
          async prepare() {
            const title = String(input.title ?? "").replace(/\s+/g, " ").trim();
            if (!title) throw new Refusal("A new title is needed.");
            if (title.length > MAX_TITLE_CHARS) throw new Refusal(`A title is at most ${MAX_TITLE_CHARS} characters; this one is ${title.length}.`);
            const doc = await needDocument(input);
            if (doc.title === title) throw new Refusal(`The document is already called "${title}".`);
            return { doc, title, ids: { projectId: doc.matter_id, documentId: doc.id, versionId: doc.latest?.id ?? null } };
          },
          async write({ doc, title }) {
            const { error } = await supabase.from("matter_documents").update({ title }).eq("id", doc.id);
            if (error) throw new Error(dbFailure(error.message, "rename the document"));
            return `"${doc.title}" on ${doc.matter.name} is now called "${title}"; its type${doc.document_type?.name ? ` (${doc.document_type.name})` : ""}, status and versions are unchanged.\n${documentLink(doc)}`;
          },
        });
      },
    },
    {
      name: "set_document_status",
      title: "Set a document's status",
      description: `Move a project document along the Hub's status line: ${DOCUMENT_STATUSES.map(statusWords).join(" → ")}. Use it when the lawyer says a document has gone to the client, come back from the counterparty, is final, or has been signed. Give the document's id (documentId, from find_document_by_title) or the id of any of its versions (versionId), and the new status in those words. It changes the status only, for the whole document (not one version); the reply says what the status was. Nothing is sent to anyone. The lawyer is asked before it is written.`,
      inputSchema: {
        documentId: z.string().optional().describe("The document's id (documentId in find_document_by_title). Give this or versionId."),
        versionId: z.string().optional().describe("Or the id of any version of the document, from list_project_documents."),
        // A string, not an enum: the description names the statuses with
        // spaces, and the SDK would refuse "internal review" before the
        // tool could read it; statusValue takes any spelling.
        status: z.string().describe(`The new status: one of ${DOCUMENT_STATUSES.map(statusWords).join(", ")} (spelt with spaces or underscores).`),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        return perform(ctx, "set_document_status", {
          async prepare() {
            const status = statusValue(input.status);
            if (!status) throw new Refusal(`The status must be one of ${DOCUMENT_STATUSES.join(", ")}.`);
            const doc = await needDocument(input);
            if (doc.status === status) throw new Refusal(`${describe(doc)} is already "${statusWords(status)}".`);
            return { doc, status, ids: { projectId: doc.matter_id, documentId: doc.id, versionId: doc.latest?.id ?? null } };
          },
          async write({ doc, status }) {
            const { error } = await supabase.from("matter_documents").update({ status }).eq("id", doc.id);
            if (error) throw new Error(dbFailure(error.message, "set the status"));
            return `${describe(doc)} is now "${statusWords(status)}" (it was "${statusWords(doc.status ?? "not_started")}").\n${documentLink(doc)}`;
          },
        });
      },
    },
    {
      name: "create_document_record",
      title: "Create an empty document record",
      description: `Make a new, empty document record on a project (a title, optionally a document type, status "${statusWords(NEW_RECORD_STATUS)}", no versions yet), the way "New document" on the project page does. Use it when a document should appear on the project before there is a file for it, or when a saving tool needs a document to put a first version into; a saving tool can also create the record itself, so do not call this first unless the lawyer wants the record on its own. documentTypeId (from list_document_types) sets which Word standard a draft of it fills, and cannot be changed from claude.ai afterwards. The reply gives the new documentId. The lawyer is asked before it is written; the record carries them as its creator.`,
      inputSchema: {
        projectId: z.string().describe("The project's id, from list_projects or find_document_by_title."),
        title: z.string().describe(`The document's title, up to ${MAX_TITLE_CHARS} characters.`),
        documentTypeId: z.string().optional().describe("Optional: a document type's id, from list_document_types."),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        return perform(ctx, "create_document_record", {
          async prepare() {
            const title = String(input.title ?? "").replace(/\s+/g, " ").trim();
            if (!title) throw new Refusal("A title for the document is needed.");
            if (title.length > MAX_TITLE_CHARS) throw new Refusal(`A title is at most ${MAX_TITLE_CHARS} characters; this one is ${title.length}.`);
            const matter = await needProject(input);
            let type = null;
            if (input.documentTypeId != null && String(input.documentTypeId).trim()) {
              const typeId = uuid(input.documentTypeId);
              if (!typeId) throw new Refusal("documentTypeId must be a document type's id (a UUID). list_document_types gives them.");
              const { data, error } = await supabase.from("document_types").select("id, name").eq("id", typeId).maybeSingle();
              if (error) throw new Error(`Could not read the document type: ${error.message}`);
              if (!data) throw new Refusal("There is no document type with that id. list_document_types gives them.");
              type = data;
            }
            return { matter, title, type, ids: { projectId: matter.id } };
          },
          async write({ matter, title, type }) {
            const row = { id: randomUUID(), matter_id: matter.id, title, document_type_id: type?.id ?? null, status: NEW_RECORD_STATUS, created_by: author(ctx) };
            const { error } = await supabase.from("matter_documents").insert(row);
            if (error) throw new Error(dbFailure(error.message, "create the document record"));
            return `Created "${title}"${type ? ` (${type.name})` : ""} on ${matter.name}: status ${statusWords(NEW_RECORD_STATUS)}, no versions yet. documentId: ${row.id}. Save its first version with a saving tool (save_note_to_project or save_draft_to_project, with matterDocumentId ${row.id}) or upload one on the Hub.\n${open("project", matter.id)}`;
          },
        });
      },
    },
    {
      name: "reindex_document",
      title: "Ask the Hub to read a version again",
      description: "Ask the Hub to read one version of a project document again: extract its text, write its index card and run its checks, so read_document, get_document_summary and the searches see it. Use it when a version shows as \"could not be read\" or \"not read yet\" in list_project_documents or get_project_overview, or after the lawyer says a scanned file should be tried again (\"try reading the scanned annex again\"). It changes nothing in the file; the Hub reads it afresh in the background, usually within a minute, longer for a scanned PDF. Calling it twice does no harm: a version already queued or being read is left alone. The lawyer is asked before it runs.",
      inputSchema: {
        versionId: z.string().describe("The document version's id, from list_project_documents or get_project_overview."),
      },
      write: true,
      annotations: Object.freeze({ ...WRITE, idempotentHint: true }),
      async run(input, ctx) {
        return perform(ctx, "reindex_document", {
          async prepare() {
            const v = await needVersion(input, "id, version_number, file_name, indexing_status, indexing_error");
            return { v, ids: { projectId: v.matter_document.matter.id, documentId: v.matter_document.id, versionId: v.id } };
          },
          async write({ v }) {
            const { data, error } = await supabase.rpc("enqueue_index_job", { p_version_id: v.id });
            if (error) throw new Error(dbFailure(error.message, "queue the reading"));
            const state = data && typeof data === "object" ? String(data.state ?? "") : "";
            const name = `${versionName(v)} on ${v.matter_document.matter.name}`;
            const link = open("version", v.id);
            if (state === "unsupported") throw new Refusal(`The Hub cannot read files of this kind (${name}): it reads Word, PDF, text, Markdown and the common office formats. Nothing was queued.`);
            if (state === "running") return `${name} is being read by the Hub right now; nothing more was queued. Call get_document_summary in a minute or two.\n${link}`;
            const before = v.indexing_status === "failed" ? ` It could not be read last time${v.indexing_error ? ` (${short(v.indexing_error, 160)})` : ""}.` : "";
            return `The Hub will read ${name} again now.${before} Call get_document_summary on it in about a minute (longer for a scanned PDF); the project page shows its progress.\n${link}`;
          },
        });
      },
    },
  ];
};
