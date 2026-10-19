// Piece 2.1: the first two tools that file something from claude.ai. A note
// or memo written in claude.ai is saved into a project as a Markdown file
// (save_note_to_project), or rendered to the firm's house-format Word file
// first (save_draft_to_project: aklaRender.js, the same renderer the Hub's
// own chat delivers every document through). Either way the save is a new
// version, of a new document or the next version of an existing one, never
// over a version that exists: a colleague's newer version is refused with
// "A newer version exists" rather than buried.
//
// Both go through the write foundation (connector/projectWrites.js, handed
// in as deps.writes): checkCaps first (the sign-in afresh, then 30 writes
// an hour and 200 a day), saveVersion (the upload under the site's path
// shape and save_document_version_as as the lawyer, is_ai_generated false,
// the label saying the version came from claude.ai), recordAction last
// (one connector_actions row, never the text), and the caps handle
// released in a finally. The index worker reads the new version within a
// minute, queued by the database's own trigger.
//
// The Word renderer is Python on the VM (akla/build_docx.py in the
// chat-service's .akla-venv, shipped by deploy.sh beside aklaRender.js);
// renderAklaDocx spawns it with the Markdown on stdin and gives back the
// bytes and the house-format check. A test hands createSaveTools a stub in
// its place, since deps carries no renderer of its own. If the renderer
// fails the tool says so and points at save_note_to_project, which needs
// nothing but the database.

import { z } from "zod";
import { WRITE } from "../app.js";
import { str, uuid } from "../tools.js";
import { renderAklaDocx } from "../../aklaRender.js";

/** The most Markdown either tool takes in one save (the plan's cap). */
export const MAX_MARKDOWN_CHARS = 600_000;
/** How long the Word renderer may take; the connector has no request timeout of its own (connector.js). */
export const RENDER_TIMEOUT_MS = 60_000;
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const NOTE_TOOL = "save_note_to_project";
export const DRAFT_TOOL = "save_draft_to_project";
const MAX_TITLE_CHARS = 200;
const MAX_LABEL_CHARS = 200;
const MAX_WARNINGS = 5;

const SAVE_RULES = "It always saves a NEW version, never over one that exists, and claude.ai asks the lawyer before it runs; every save is recorded against the lawyer. Give matterDocumentId to save as the next version of an existing document (and expectedVersionId, the version you read, so a colleague's newer version is never buried: a stale one is refused); leave both out for a new document on the project. Saving is filing, not legal approval.";
/** What the title input means, the same for both tools: it names a new document; an existing one keeps its own. */
const TITLE_RULE = "Needed for a new document. For a next version of an existing document the document's title on the Hub stays as it is (rename_document changes it); a title given here only names the file.";

/** A title as saveVersion stores it: inner whitespace collapsed (a line break would break the file name), trimmed, capped. */
const titleOf = (v) => str(typeof v === "string" ? v.replace(/\s+/g, " ") : v, MAX_TITLE_CHARS);

/** The text of the document the tool was given, within the cap, or a plain refusal. */
export function markdownOf(value, what) {
  const text = typeof value === "string" ? value.replace(/^﻿/, "") : "";
  if (!text.trim()) throw new Error(`There is nothing to save: ${what} is empty.`);
  if (text.length > MAX_MARKDOWN_CHARS) throw new Error(`The ${what} is ${text.length.toLocaleString("en")} characters; a save takes at most ${MAX_MARKDOWN_CHARS.toLocaleString("en")}. Save it in parts, or shorten it.`);
  return text;
}

/** The house-format check in one line, for the result. */
export function formatCheckLine(check, warnings = []) {
  const lines = [];
  if (!check || typeof check !== "object") lines.push("House format check: not run.");
  else if (check.status === "checked") lines.push(`House format check: passed (${check.sections ?? 0} numbered section${check.sections === 1 ? "" : "s"}, ${check.comments ?? 0} AKLA comment${check.comments === 1 ? "" : "s"}).`);
  else lines.push(`House format check: needs review. ${(check.findings ?? []).join(" ")} The file is saved as rendered; tell the Hub's owner if this keeps happening.`);
  const notes = (Array.isArray(warnings) ? warnings : []).map((w) => String(w).trim()).filter(Boolean);
  if (notes.length) lines.push(`Renderer notes: ${notes.slice(0, MAX_WARNINGS).join(" | ")}${notes.length > MAX_WARNINGS ? ` | and ${notes.length - MAX_WARNINGS} more` : ""}`);
  return lines.join("\n");
}

/**
 * The two tools, with the renderer swappable for a test. `deps` is what
 * tools.js hands every module (supabase, helpers, writes, hubUrl, log).
 */
export function createSaveTools(deps, { render = renderAklaDocx } = {}) {
  const { supabase, helpers, writes, log = () => {} } = deps;
  const { needProject, open, link } = helpers;

  /** The ids and label common to both tools, read from the input or refused in one sentence. */
  function readTarget(input) {
    const matterDocumentId = input.matterDocumentId == null || String(input.matterDocumentId).trim() === "" ? null : uuid(input.matterDocumentId);
    if (input.matterDocumentId != null && String(input.matterDocumentId).trim() !== "" && !matterDocumentId) throw new Error("matterDocumentId must be a document id (a UUID). list_project_documents gives them.");
    const expectedVersionId = input.expectedVersionId == null || String(input.expectedVersionId).trim() === "" ? null : uuid(input.expectedVersionId);
    if (input.expectedVersionId != null && String(input.expectedVersionId).trim() !== "" && !expectedVersionId) throw new Error("expectedVersionId must be a document version id (a UUID). list_project_documents gives them.");
    if (expectedVersionId && !matterDocumentId) throw new Error("expectedVersionId only makes sense with matterDocumentId: name the document the version belongs to, or leave both out for a new document.");
    return { matterDocumentId, expectedVersionId, title: titleOf(input.title), label: str(input.label, MAX_LABEL_CHARS) };
  }

  /**
   * The existing document a next version goes on, checked to be on this
   * project so the refusal is plain, and its latest version against the
   * one the caller read, so a stale save is turned away (and recorded as
   * refused) before a minute's render; saveVersion checks both again at
   * the moment of saving. The title stands in when the caller gives none.
   */
  async function existingDocument({ tool, ctx, matter, target }) {
    const { data, error } = await supabase.from("matter_documents").select("id, title, matter_id").eq("id", target.matterDocumentId).maybeSingle();
    if (error) throw new Error(`Could not read the document: ${error.message}`);
    if (!data) throw new Error("There is no project document with that id. list_project_documents gives them.");
    if (data.matter_id !== matter.id) throw new Error(`That document is not on ${matter.name}.`);
    target.documentTitle = titleOf(data.title);
    target.title ??= target.documentTitle;
    if (target.expectedVersionId) {
      const { data: latest, error: latestError } = await supabase.from("document_versions").select("id, version_number").eq("matter_document_id", data.id).order("version_number", { ascending: false }).limit(1).maybeSingle();
      if (latestError) throw new Error(`Could not read the document's versions: ${latestError.message}`);
      if (latest && latest.id !== target.expectedVersionId) {
        await writes.recordAction(ctx, { tool, projectId: matter.id, documentId: data.id, outcome: "refused" }).catch(() => {});
        throw new Error(`A newer version exists (v${latest.version_number}): read it before saving the next one.`);
      }
    }
    return data;
  }

  /** The document type a new document is filed under, when one is named; the Hub's picker is the usual place for this. */
  async function documentTypeOf(input) {
    if (input.documentTypeId == null || String(input.documentTypeId).trim() === "") return null;
    const id = uuid(input.documentTypeId);
    if (!id) throw new Error("documentTypeId must be a document type id (a UUID). list_document_types gives them.");
    const { data, error } = await supabase.from("document_types").select("id, name").eq("id", id).maybeSingle();
    if (error) throw new Error(`Could not read the document type: ${error.message}`);
    if (!data) throw new Error("There is no document type with that id. list_document_types gives them.");
    return data;
  }

  /**
   * The save itself, the same for both tools once the bytes exist: through
   * saveVersion, recorded whatever happens, answered with the ids and the
   * Hub pages. `prepare` runs between checkCaps and the save (the render),
   * so its failure is recorded too. The reply names the document as the
   * Hub lists it: a next version keeps the document's own title, whatever
   * title named the file.
   */
  async function fileInto({ tool, ctx, matter, target, prepare }) {
    const record = (fields) => writes.recordAction(ctx, { tool, projectId: matter.id, ...fields }).catch((err) => log(`${tool}: the record could not be written: ${err?.message ?? err}`));
    let saved;
    let extra = null;
    try {
      const prepared = await prepare();
      extra = prepared.extra ?? null;
      saved = await writes.saveVersion({ ctx, projectId: matter.id, title: target.title, matterDocumentId: target.matterDocumentId, documentTypeId: prepared.documentTypeId, expectedVersion: target.expectedVersionId, bytes: prepared.bytes, fileName: prepared.fileName, mime: prepared.mime, label: target.label });
    } catch (err) {
      await record({ documentId: target.matterDocumentId, outcome: "failed" });
      throw err;
    }
    await record({ documentId: saved.matterDocumentId, versionId: saved.versionId, label: saved.label, outcome: "saved" });
    const shown = saved.created ? target.title : target.documentTitle ?? target.title;
    const where = saved.created ? `a new document on ${matter.name}` : `its next version on ${matter.name}`;
    return [
      `Saved "${shown}" as v${saved.versionNumber} (${saved.fileName}), ${where}, labelled "${saved.label}".`,
      `documentId: ${saved.matterDocumentId}`,
      `versionId: ${saved.versionId}`,
      open("version", saved.versionId),
      `Project ${matter.name} — Open in Hub: ${link("project", matter.id)}`,
      ...(extra ? [extra] : []),
      saved.note,
      "Filed as the lawyer's own version (not marked AI-generated), with the label saying it came from claude.ai; filing is not legal approval.",
    ].join("\n");
  }

  return [
    {
      name: NOTE_TOOL,
      title: "Save a note or memo into a project",
      description: `Save text you have written in this chat (a note, memo, summary, list of points; plain text or Markdown) into a project on the Hub as a Markdown file, where colleagues can open it and the Hub reads it for search within a minute. Use it when the lawyer asks to save, file or put something on a project. ${SAVE_RULES} For a draft document in the firm's house format use save_draft_to_project instead. Takes up to ${MAX_MARKDOWN_CHARS.toLocaleString("en")} characters. Returns the new version's id and its Hub page.`,
      inputSchema: {
        projectId: z.string().describe("The project's id, from list_projects or find_document_by_title."),
        text: z.string().describe("The text to save, as written: plain text or Markdown."),
        title: z.string().optional().describe(`The title of a NEW document on the Hub, e.g. "Notes on the term sheet". ${TITLE_RULE}`),
        matterDocumentId: z.string().optional().describe("Optional: an existing document's id (documentId from list_project_documents) to save this as its next version. Leave out for a new document."),
        expectedVersionId: z.string().optional().describe("Optional, with matterDocumentId: the id of the latest version you read. The save is refused if a newer one exists."),
        label: z.string().optional().describe("Optional: a short label for the version, e.g. \"For partner review\". \"saved from claude.ai\" is added to it."),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        const caps = await writes.checkCaps(ctx);
        try {
          const text = markdownOf(input.text, "text");
          const target = readTarget(input);
          const matter = await needProject(input);
          if (target.matterDocumentId) await existingDocument({ tool: NOTE_TOOL, ctx, matter, target });
          if (!target.title) throw new Error("A title for the new document is needed, e.g. \"Notes on the term sheet\".");
          return await fileInto({
            tool: NOTE_TOOL, ctx, matter, target,
            prepare: async () => ({ bytes: Buffer.from(text, "utf8"), fileName: `${target.title}.md`, mime: "text/markdown", documentTypeId: null, extra: null }),
          });
        } finally {
          caps.release();
        }
      },
    },
    {
      name: DRAFT_TOOL,
      title: "Save a draft into a project as a house-format Word file",
      description: `Save a draft document written in this chat into a project on the Hub as a Word file in AKLA's house format: A4, Arial 11, the title on the navy banner, numbered 1. / 1.1. headings, and [[AKLA Comment: …]] notes as Word margin comments (get_firm_rules with task draft gives the Markdown shape the renderer expects). Use it when the lawyer asks to save or file a draft agreement, memo or notes in the firm's format; the Hub reads the file for search within a minute. ${SAVE_RULES} documentTypeId (from list_document_types) files a new document under a type; an existing document keeps its type. The rendering takes up to a minute. Takes up to ${MAX_MARKDOWN_CHARS.toLocaleString("en")} characters of Markdown. Returns the new version's id, its Hub page and the house-format check's notes; if the renderer fails, save_note_to_project saves the same text as a Markdown file.`,
      inputSchema: {
        projectId: z.string().describe("The project's id, from list_projects or find_document_by_title."),
        markdown: z.string().describe("The whole document as Markdown in the firm's shape: # title, ## numbered sections, [[AKLA Comment: …]] for margin comments, [●] for blanks."),
        title: z.string().optional().describe(`The title of a NEW document on the Hub and on the Word file's banner, e.g. "Notes on the Concession Agreement". ${TITLE_RULE.replace("names the file", "names the file and goes on the banner")}`),
        documentTypeId: z.string().optional().describe("Optional, for a new document: the document type's id from list_document_types."),
        matterDocumentId: z.string().optional().describe("Optional: an existing document's id (documentId from list_project_documents) to save this as its next version. Leave out for a new document."),
        expectedVersionId: z.string().optional().describe("Optional, with matterDocumentId: the id of the latest version you read. The save is refused if a newer one exists."),
        label: z.string().optional().describe("Optional: a short label for the version, e.g. \"First draft for the client\". \"saved from claude.ai\" is added to it."),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        const caps = await writes.checkCaps(ctx);
        try {
          const markdown = markdownOf(input.markdown, "markdown");
          const target = readTarget(input);
          const matter = await needProject(input);
          if (target.matterDocumentId) await existingDocument({ tool: DRAFT_TOOL, ctx, matter, target });
          if (!target.title) throw new Error("A title for the new document is needed, e.g. \"Notes on the Concession Agreement\".");
          // A type applies to a new document only; an existing one keeps its own.
          const type = target.matterDocumentId ? null : await documentTypeOf(input);
          return await fileInto({
            tool: DRAFT_TOOL, ctx, matter, target,
            prepare: async () => {
              let rendered;
              try {
                rendered = await render({ markdown, title: target.title, timeoutMs: RENDER_TIMEOUT_MS });
              } catch (err) {
                log(`${DRAFT_TOOL} for ${ctx?.userId ?? "?"}: the renderer failed: ${err?.message ?? err}`);
                throw new Error(`The Word file could not be made (${String(err?.message ?? err).replace(/\.$/, "")}); nothing was saved. save_note_to_project saves the same text as a Markdown file instead.`);
              }
              if (!(rendered?.bytes instanceof Uint8Array) || !rendered.bytes.length) throw new Error("The Word file could not be made (the renderer returned nothing); nothing was saved. save_note_to_project saves the same text as a Markdown file instead.");
              return { bytes: rendered.bytes, fileName: `${target.title}.docx`, mime: DOCX_MIME, documentTypeId: type?.id ?? null, extra: formatCheckLine(rendered.check, rendered.warnings) };
            },
          });
        } finally {
          caps.release();
        }
      },
    },
  ];
}

export default (deps) => createSaveTools(deps);
