// A file from the claude.ai chat into a project: upload_file_to_project
// (writes) and get_upload (reads). The machinery is connector/uploads.js:
// the one-time upload address, its drop page and the save through the write
// foundation. This module checks what the lawyer asked for (the project, the
// document, an allowed file name), then either files a small file sent as
// base64 at once or hands back the address and the exact curl line for
// Claude's code sandbox.
//
// The owner's decisions (22 Oct 2026): "allow the file upload, no need for
// safety", reversing the earlier rule that claude.ai never gets a direct
// link; and "force connector drafting wherever possible", so a file Claude
// made in its sandbox with a skill is filed here rather than left in the
// chat.
//
// Issuing an address changes nothing on the Hub, so it is not a row in
// connector_actions; it still passes checkCaps (the sign-in afresh, and a
// lawyer at the cap is told now rather than after the upload). The upload
// itself is the write: recorded and capped when the file lands.

import { z } from "zod";
import { WRITE } from "../app.js";
import { str, uuid } from "../tools.js";
import { ADDRESS_TTL_MS, MAX_INLINE_BYTES, MAX_UPLOAD_BYTES, STATUS_TOOL, UPLOAD_TOOL, checkFileName, fileUpload, titleFromFileName } from "../uploads.js";
import { MAX_LABEL_CHARS, MAX_TITLE_CHARS } from "../projectWrites.js";

const MB = 1024 * 1024;
const NO_ADDRESSES = "Upload addresses are not available on this connector; send a small file as contentBase64, or upload it in the Hub.";
const RESTART_NOTE = "A connector restart (a deploy) voids an address that has not been used; if get_upload says it does not know the id, make a new one.";

/** Base64 (or base64url, with or without a data: prefix and line breaks) to bytes, or a plain refusal. */
export function bytesOfBase64(value) {
  const s = String(value ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!s) throw new Error("contentBase64 is empty; leave it out to get an upload address instead.");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) throw new Error("contentBase64 is not base64; leave it out to get an upload address instead.");
  if (Math.floor((s.length * 3) / 4) > MAX_INLINE_BYTES + 3) throw new Error(`contentBase64 is for files up to ${MAX_INLINE_BYTES / MB} MB; leave it out and use the upload address for this one.`);
  const bytes = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length > MAX_INLINE_BYTES) throw new Error(`contentBase64 is for files up to ${MAX_INLINE_BYTES / MB} MB; leave it out and use the upload address for this one.`);
  return bytes;
}

/** A path as the sandbox shell needs it: quoted, with any quote in it escaped. */
const shellQuote = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;

export default (deps) => {
  const { supabase, helpers, writes, uploads = null, hubUrl, log = () => {} } = deps;
  const { needProject, link, open } = helpers;

  /** What the lawyer asked to file, checked: { projectId, projectName, documentId, documentTitle, title, fileName, extension, label }. */
  async function targetOf(input) {
    const { fileName, extension } = checkFileName(input.fileName);
    const matter = await needProject(input);
    let documentId = null;
    let documentTitle = null;
    if (input.documentId != null && String(input.documentId).trim() !== "") {
      documentId = uuid(input.documentId);
      if (!documentId) throw new Error("documentId must be a document id (a UUID). list_project_documents gives them.");
      const { data, error } = await supabase.from("matter_documents").select("id, title, matter_id").eq("id", documentId).maybeSingle();
      if (error) throw new Error(`Could not read the document: ${error.message}`);
      if (!data) throw new Error("There is no project document with that id. list_project_documents gives them.");
      if (data.matter_id !== matter.id) throw new Error(`That document is not on ${matter.name}.`);
      documentTitle = String(data.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS) || "Untitled document";
    }
    const given = str(typeof input.title === "string" ? input.title.replace(/\s+/g, " ") : null, MAX_TITLE_CHARS);
    return { projectId: matter.id, projectName: matter.name, documentId, documentTitle, title: documentTitle ?? given ?? titleFromFileName(fileName), fileName, extension, label: str(input.label, MAX_LABEL_CHARS) };
  }

  return [
    {
      name: UPLOAD_TOOL,
      title: "Upload a file from this chat into a project",
      description: `File a whole file into a project on the Hub, as a new document or as the next version of one (documentId). Use it when the lawyer attached a file to this chat (a Word draft, a PDF, a spreadsheet) and wants it filed, marked up or reviewed in the Hub, and whenever you made a file in your code sandbox (with a skill: a memo, a deck, a register, a formatted volume) that belongs in a project: a firm document is filed in the Hub, never handed over only as a file in the chat. Word, PDF, Excel, PowerPoint, image and text files, up to ${MAX_UPLOAD_BYTES / MB} MB; any other kind is refused. Without contentBase64 it returns a one-time upload address (yours, for this project, document and file name, for ${ADDRESS_TTL_MS / 60000} minutes, used once) and the exact curl line: run it in your code sandbox (/mnt/user-data/uploads/ holds the lawyer's attachments, /mnt/user-data/outputs/ what you made). claude.ai's sandbox may block the network: if curl fails, give the lawyer the address, written out in full on its own line, to open in a browser and drop the file in. Then call ${STATUS_TOOL} for the documentId, versionId and Open in Hub address, and go on to mark it up or review it. contentBase64 files at once and is only for small files (up to ${MAX_INLINE_BYTES / MB} MB), since you write every character of it. The version is the lawyer's own (not AI-generated), labelled "Uploaded from claude.ai — <date>" unless you give a label; claude.ai asks the lawyer first, every upload is recorded against them, and nothing is ever replaced or deleted.`,
      inputSchema: {
        projectId: z.string().describe("The project's id, from list_projects or find_document_by_title."),
        fileName: z.string().describe("The file's name with its extension, e.g. \"Share Purchase Agreement (draft 3).docx\". The extension decides the kind; the upload must be that kind."),
        title: z.string().optional().describe("Optional: the title of a NEW document on the Hub; the file's name without its extension when left out. A next version keeps its document's title."),
        documentId: z.string().optional().describe("Optional: an existing document's id (documentId from list_project_documents) to file this as its next version. Leave out for a new document."),
        label: z.string().optional().describe("Optional: a short label for the version, e.g. \"Client's mark-up of 21 October\". \"uploaded from claude.ai\" is added to it."),
        contentBase64: z.string().optional().describe(`Optional, small files only (up to ${MAX_INLINE_BYTES / MB} MB): the file itself as base64, filed at once. Leave it out to get an upload address.`),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        const target = await targetOf(input);
        const where = target.documentId ? `the next version of "${target.documentTitle}"` : `a new document, "${target.title}"`;
        if (input.contentBase64 != null && String(input.contentBase64).trim() !== "") {
          const bytes = bytesOfBase64(input.contentBase64);
          const out = await fileUpload({ writes, ctx, target, bytes, hubUrl, log });
          return out.text;
        }
        if (!uploads) throw new Error(NO_ADDRESSES);
        // The sign-in afresh and the caps, now: an address the lawyer could
        // not use anyway is not handed out. Nothing is recorded yet.
        const caps = await writes.checkCaps(ctx);
        caps.release();
        const issued = uploads.issue(ctx, target);
        const folder = "/mnt/user-data/uploads/";
        return [
          `Upload address ready: ${target.fileName} goes to ${target.projectName} as ${where}.`,
          `uploadId: ${issued.uploadId}`,
          `It files one .${target.extension} file of up to ${MAX_UPLOAD_BYTES / MB} MB, once, until ${issued.until} (${ADDRESS_TTL_MS / 60000} minutes).`,
          "",
          "Send it from your code sandbox (the path of the file there; your own output is under /mnt/user-data/outputs/):",
          `curl -sS -F ${shellQuote(`file=@${folder}${target.fileName}`)} ${issued.address}`,
          "It answers with the documentId, the versionId and the Open in Hub address.",
          "",
          "If curl cannot reach it (claude.ai's sandbox may block the network), give the lawyer this address, written out in full on its own line, to open in a browser and drop the file in:",
          `Upload page: ${issued.address}`,
          "",
          `Then call ${STATUS_TOOL} with this uploadId to confirm it arrived. ${RESTART_NOTE}`,
          `Project ${target.projectName} — ${open("project", target.projectId)}`,
        ].join("\n");
      },
    },
    {
      name: STATUS_TOOL,
      title: "Whether an uploaded file has arrived",
      description: `Whether the file for an upload address (from ${UPLOAD_TOOL}) has arrived and been filed. When it has: the documentId, the versionId and the "Open in Hub:" address, so you can go straight on to read it (get_document_summary), mark it up (show_document_paragraphs, apply_tracked_changes) or review it (start_review). Otherwise whether the address is still waiting (and until when), a file is arriving now, or it expired. Only the lawyer who asked for the address can see it.`,
      inputSchema: {
        uploadId: z.string().describe(`The uploadId ${UPLOAD_TOOL} gave.`),
      },
      async run(input, ctx) {
        const uploadId = uuid(input.uploadId);
        if (!uploadId) throw new Error(`uploadId must be the id ${UPLOAD_TOOL} gave (a UUID).`);
        const status = uploads ? uploads.statusOf(uploadId, ctx?.userId) : null;
        if (status?.state === "arrived") return `Arrived and filed.\n${status.result.text}`;
        if (status?.state === "receiving") return "A file is arriving at that address now; ask again in a few seconds.";
        if (status?.state === "expired") return `No file arrived; the address expired at ${status.until}. Make a new one with ${UPLOAD_TOOL}.`;
        if (status?.state === "waiting") return `Not arrived yet. The address is open until ${status.until} (about ${status.minutesLeft} minute${status.minutesLeft === 1 ? "" : "s"} left). If curl could not reach it, give the lawyer the upload address, written out in full on its own line, to open and drop the file in.`;
        // Not known to this process (a restart since, or another lawyer's
        // id): a file that arrived is stored under "<uploadId>-<name>".
        const { data, error } = await supabase.from("document_versions").select("id, version_number, file_name, matter_document_id, uploaded_by, storage_path, label").like("storage_path", `%/${uploadId}-%`).limit(1);
        if (error) throw new Error(`Could not look the upload up: ${error.message}`);
        const row = (data ?? [])[0];
        if (row && row.uploaded_by === uuid(ctx?.userId)) {
          const projectId = String(row.storage_path).split("/")[0];
          return [
            `Arrived and filed as v${row.version_number} (${row.file_name})${row.label ? `, labelled "${row.label}"` : ""}.`,
            `documentId: ${row.matter_document_id}`,
            `versionId: ${row.id}`,
            open("version", row.id),
            ...(uuid(projectId) ? [`Project — Open in Hub: ${link("project", projectId)}`] : []),
          ].join("\n");
        }
        return `No upload with that id is waiting for you. The address may have expired (they last ${ADDRESS_TTL_MS / 60000} minutes), or the connector restarted before the file was sent, which voids an unused address. Make a new one with ${UPLOAD_TOOL}.`;
      },
    },
  ];
};
