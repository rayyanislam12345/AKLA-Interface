// Piece 3.2 of the connector: fill_standard_to_project. The lawyer's own
// Claude has read the firm's Word standard for a document type (3.1,
// open_standard_for_filling: the placeholder paragraphs numbered ¶n and a
// fingerprint of the file), asked the firm's drafting questions in prose,
// and now sends the facts as operations against those numbers. This tool
// fills the real standard the way the Hub's own "draft from the standard"
// turn does (server.js, the docxBase path: inspectDocx, alignCommentExpectations,
// applyDocxOps, acceptChangesBy, describeResults), then files the result
// as a new version in the project through the write foundation
// (connector/projectWrites.js). Numbering, styles, headers, the contents
// page and every paragraph the ops do not name come out as they went in,
// because the file is edited as a Word file, never rebuilt from text.
//
// What the lawyer gets: facts in the right slots, born accepted (a draft
// from the standard is a new document, with nothing to accept one by one);
// every value not given still [●]; open questions as "AKLA Comments"
// margin comments; the reply naming every change that could not be made
// and why, and every blank still in the file.
//
// What is never done: the standard in the precedent library is read and
// never written (the fill goes to the matter-documents bucket, as a new
// document or the next version of one the lawyer names); nothing is saved
// when the standard was replaced between open and fill (its sha256 no
// longer matches templateHash), when no change could be made, or when the
// fill takes longer than APPLY_TIMEOUT_MS (so the docx-redline-js fallback
// inside applyDocxOps cannot outlast claude.ai's 240 s per call: "took too
// long, nothing written"), or when the filled file's format differs from
// the standard's (the format gate, formatFingerprint.js checkFormat; the
// reply lists what differs, and FORMAT_GATE=report saves it anyway with
// that list as a warning). No redline_suggestions rows: the fills are
// accepted, and the Hub's "What changed" tab compares versions itself.
//
// The write foundation's order holds: checkCaps first (the sign-in afresh,
// then 30 an hour and 200 a day), the work, recordAction last (one row,
// never the text), release() in a finally. The version is the lawyer's
// own filing (is_ai_generated false), labelled "Drafted from the firm's
// standard in claude.ai — <date>" with the lawyer's own label in front
// when one is given. Node 20: nothing newer is used.
//
// One fill at a time in this process: reading a two-thousand-paragraph
// standard whole, applying the changes and accepting them takes the
// connector to about 500 MB resident (the churn is zip output and the
// document part re-sliced per change, outside the JS heap), and the unit
// runs under a MemoryMax (hub-connector.service). A second fill while one
// runs is refused in one sentence, as compare_text_with_version refuses a
// second read; the lock is released in the same finally as the caps handle.
// The standard's rows are read through fillStandard.js's standardRows and
// the file is downloaded afresh, not from 3.1's cache: the sha256 check is
// of the bytes as they are now.

import { createHash } from "node:crypto";
import { z } from "zod";
import { WRITE } from "../app.js";
import { str, uuid } from "../tools.js";
import { inspectDocx, applyDocxOps, acceptChangesBy, describeResults, stripXmlIllegal, DOCX_AUTHOR } from "../../docxAgent.js";
import { alignCommentExpectations } from "../../libraryTools.js";
import { standardRows, isWordFile } from "./fillStandard.js";
import { checkFormat, variableLinesFor } from "../../formatFingerprint.js";
import { packOf } from "../../draftingPacks.js";
import { draftingOf, autoCommentOps, skeletonGate, connectorConfirmSentence } from "../../draftChecks.js";
import { DOCUMENT_UI } from "../apps.js";
import { documentPanelContent } from "./documentPanel.js";

export const FILL_TOOL = "fill_standard_to_project";
/** The bucket the firm's standards live in (server.js guideStart, the same download). */
export const STANDARDS_BUCKET = "precedent-library";
/** The most operations one call applies (the plan's cap). */
export const MAX_OPS = 300;
/** The most characters one operation's text or expected text may carry (the plan's zod cap). */
export const MAX_OP_TEXT_CHARS = 20_000;
/** How long the fill may take before nothing is written: under claude.ai's 240 s per call, with the upload still to come. */
export const APPLY_TIMEOUT_MS = 200_000;
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const OP_KINDS = Object.freeze(["replace", "insert_after", "delete", "comment", "write", "repeat_block", "add_row", "remove_block"]);
/** The block operations (docxAgent.js BLOCK_OPS): the paragraph each names in place of "p", the one "expected" quotes first. */
export const BLOCK_OP_FIELDS = Object.freeze({
  write: ["after"],
  repeat_block: ["from", "to", "after"],
  add_row: ["like_row", "table"],
  remove_block: ["from", "to"],
});
/** The most blocks one write, or cells one row, carries. */
export const MAX_BLOCKS = 200;
const MAX_TITLE_CHARS = 200;
const MAX_LABEL_CHARS = 200;
const MAX_WHY_CHARS = 300;
/** How many unfilled changes and remaining blanks the reply lists in full before counting the rest. */
const MAX_LISTED = 60;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export const STANDARD_CHANGED_SENTENCE = "The firm's standard has changed since you opened it, so nothing was saved; open it again with open_standard_for_filling and resend the changes against the new listing.";
export const TOO_LONG_SENTENCE = `The fill took too long (over ${Math.round(APPLY_TIMEOUT_MS / 1000)} seconds) and nothing was written; send fewer changes in one call, then the rest as the next version.`;
export const BUSY_SENTENCE = "Another fill is running on the Hub; nothing was saved. Try again in a minute with the same changes.";
export const UNRECORDED_LINE = "The save landed but could not be recorded in the Hub's log; tell the Hub's owner.";
/** The most clause-list ids one call may confirm as left out. */
export const MAX_CONFIRMED = 100;

/**
 * confirmedOmissions as given: the clause-list ids the lawyer confirmed may
 * be left out (the refusal names them), at most MAX_CONFIRMED, each a short
 * id. Shared with apply_tracked_changes.
 */
export function readConfirmed(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error("confirmedOmissions must be a list of the clause-list ids the refusal named, e.g. [\"governing_law\"].");
  const ids = [...new Set(value.map((v) => v.trim()).filter(Boolean))];
  if (ids.length > MAX_CONFIRMED || ids.some((v) => v.length > 80)) throw new Error(`confirmedOmissions takes at most ${MAX_CONFIRMED} ids, each as the refusal named it.`);
  return ids;
}
// The parts whose bracketed text is a slot to fill; the rest (footnotes,
// endnotes) carry the firm's drafting notes.
const SLOT_PART = /^word\/(document|header\d+|footer\d+)\.xml$/;

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Karachi" });

// The process-wide lock (see the header).
let filling = false;
/** Whether a fill is running in this process (tests). */
export const isFilling = () => filling;

/** The sha256 of a file's bytes, lower-case hex: the fingerprint open_standard_for_filling prints and this tool checks. */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The label the filed version carries: "Drafted from the firm's standard
 * in claude.ai — 20 October 2026", with the lawyer's own label in front
 * when one is given ("For partner review: Drafted from …"), within the
 * column's width.
 */
export function fillLabel(label, at = new Date()) {
  const base = `Drafted from the firm's standard in claude.ai — ${dateFmt.format(at)}`;
  const own = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!own) return base;
  const room = MAX_LABEL_CHARS - base.length - 2;
  return `${own.length > room ? `${own.slice(0, room - 1)}…` : own}: ${base}`;
}

// One block of a write: a paragraph kind with its text, or a table kind
// with its rows (docxAgent.js checks the kind against the pack's list).
function readBlock(raw, n, b) {
  const kind = typeof raw?.kind === "string" ? raw.kind.trim() : "";
  if (!kind) throw new Error(`Change ${n}, block ${b}: kind must be one of the pack's kinds, as open_standard_for_filling listed them.`);
  if (Array.isArray(raw?.rows)) {
    const rows = raw.rows.map((row) => (Array.isArray(row) ? row.map((c) => stripXmlIllegal(c)) : null));
    if (!rows.length || rows.some((row) => !row?.length)) throw new Error(`Change ${n}, block ${b}: rows must be a list of rows, each a list of cell texts.`);
    if (rows.flat().some((c) => c.length > MAX_OP_TEXT_CHARS)) throw new Error(`Change ${n}, block ${b}: a cell is longer than ${MAX_OP_TEXT_CHARS.toLocaleString("en")} characters.`);
    return { kind, rows, ...(typeof raw.like === "string" && raw.like.trim() ? { like: raw.like.trim() } : {}) };
  }
  const text = stripXmlIllegal(raw?.text ?? "");
  if (!text.trim()) throw new Error(`Change ${n}, block ${b}: a "${kind}" block needs text.`);
  if (text.length > MAX_OP_TEXT_CHARS) throw new Error(`Change ${n}, block ${b}: text is longer than ${MAX_OP_TEXT_CHARS.toLocaleString("en")} characters; one paragraph a block.`);
  return { kind, text };
}

/**
 * The operations as applyDocxOps takes them, checked here as well as by
 * the zod schema (a test calls run directly): at most MAX_OPS, each with a
 * known op, a paragraph number, the exact expected text, and text where
 * the op needs it. The four block operations a firm pack takes (write,
 * repeat_block, add_row, remove_block) name their paragraphs by after,
 * from, to, table and like_row instead of p. A fault is one sentence
 * naming the operation.
 */
export function readOps(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("ops must be a list of at least one change ({ op, p, expected, text, why }), as open_standard_for_filling describes.");
  if (value.length > MAX_OPS) throw new Error(`${FILL_TOOL} takes at most ${MAX_OPS} changes in one call (${value.length} were sent); file the first ${MAX_OPS} now and the rest as the next version of the same document.`);
  return value.map((raw, i) => {
    const n = i + 1;
    const op = String(raw?.op ?? "").trim().toLowerCase();
    if (!OP_KINDS.includes(op)) throw new Error(`Change ${n}: op must be one of ${OP_KINDS.join(", ")}.`);
    const why = typeof raw?.why === "string" && raw.why.trim() ? raw.why.replace(/\s+/g, " ").trim().slice(0, MAX_WHY_CHARS) : undefined;
    if (BLOCK_OP_FIELDS[op]) {
      const fields = {};
      for (const key of BLOCK_OP_FIELDS[op]) {
        if (raw?.[key] == null && key === "table") continue;
        const v = Number(raw?.[key]);
        if (!Number.isInteger(v) || v < 1) throw new Error(`Change ${n}: ${op} needs ${key}, a paragraph's number (¶n) from the listing.`);
        fields[key] = v;
      }
      if (typeof raw?.expected !== "string") throw new Error(`Change ${n}: expected must be the exact current text of ¶${fields[BLOCK_OP_FIELDS[op][0]]}.`);
      const expected = stripXmlIllegal(raw.expected);
      if (expected.length > MAX_OP_TEXT_CHARS) throw new Error(`Change ${n}: expected is longer than ${MAX_OP_TEXT_CHARS.toLocaleString("en")} characters.`);
      if (op === "write") {
        if (!Array.isArray(raw?.blocks) || !raw.blocks.length) throw new Error(`Change ${n}: write needs blocks, a list of {"kind", "text"} in the pack's kinds.`);
        if (raw.blocks.length > MAX_BLOCKS) throw new Error(`Change ${n}: one write takes at most ${MAX_BLOCKS} blocks.`);
        fields.blocks = raw.blocks.map((b, j) => readBlock(b, n, j + 1));
      }
      if (op === "add_row") {
        if (!Array.isArray(raw?.cells) || !raw.cells.length || raw.cells.length > MAX_BLOCKS || !raw.cells.every((c) => typeof c === "string")) throw new Error(`Change ${n}: add_row needs cells, the text of each cell left to right.`);
        fields.cells = raw.cells.map((c) => stripXmlIllegal(c));
      }
      return { op, ...fields, expected, ...(why ? { why } : {}) };
    }
    const p = Number(raw?.p);
    if (!Number.isInteger(p) || p < 1) throw new Error(`Change ${n}: p must be the paragraph's number (¶n) from the listing.`);
    if (typeof raw?.expected !== "string") throw new Error(`Change ${n}: expected must be the paragraph's exact current text.`);
    // Characters XML 1.0 forbids (they would make Word refuse the file)
    // are dropped from both texts; the file's own text never has them.
    const expected = stripXmlIllegal(raw.expected);
    if (expected.length > MAX_OP_TEXT_CHARS) throw new Error(`Change ${n}: expected is longer than ${MAX_OP_TEXT_CHARS.toLocaleString("en")} characters.`);
    const text = raw?.text == null ? "" : stripXmlIllegal(raw.text);
    if (text.length > MAX_OP_TEXT_CHARS) throw new Error(`Change ${n}: text is longer than ${MAX_OP_TEXT_CHARS.toLocaleString("en")} characters; one paragraph at a time.`);
    if (op !== "delete" && !text.trim()) throw new Error(`Change ${n}: ${op} needs text.`);
    return { op, p, expected, ...(op === "delete" ? {} : { text }), ...(why ? { why } : {}) };
  });
}

/**
 * The placeholders still in the filed file, as "[●] ×14, [Name of the
 * Grantor] ×2", most frequent first: the ones in the document, headers and
 * footers are blanks the lawyer still has to fill; the ones in the
 * footnotes and endnotes are the firm's drafting notes, said separately.
 */
export function blanksLine(placeholders) {
  const counts = new Map();
  let notes = 0;
  for (const p of Array.isArray(placeholders) ? placeholders : []) {
    const key = String(p?.text ?? "").replace(/\s+/g, " ").trim();
    if (!key) continue;
    if (p?.part && !SLOT_PART.test(p.part)) { notes++; continue; }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const notesLine = notes ? ` ${notes} bracketed drafting note${notes === 1 ? "" : "s"} in the footnotes stay${notes === 1 ? "s" : ""} as in the standard, for the lawyer to remove in Word before circulation.` : "";
  if (!counts.size) return `Blanks left in the filed draft: none.${notesLine}`;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const entries = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = entries.slice(0, MAX_LISTED).map(([text, n]) => (n > 1 ? `${text} ×${n}` : text));
  return `Blanks left in the filed draft: ${total} (${shown.join(", ")}${entries.length > MAX_LISTED ? `, and ${entries.length - MAX_LISTED} more` : ""}). They stay [●] until the lawyer fills them.${notesLine}`;
}

/**
 * The reply's account of the changes: the counts, then every change that
 * could not be made with its paragraph, the text it carried and the
 * reason, so the lawyer knows which slot is still empty and why.
 */
export function changesLines(results) {
  const changes = describeResults(results);
  const applied = changes.filter((c) => c.status === "applied");
  const skipped = changes.filter((c) => c.status !== "applied");
  const comments = applied.filter((c) => c.op === "comment").length;
  const lines = [`Changes: ${applied.length} of ${changes.length} made (${applied.length - comments} in the text, ${comments} margin comment${comments === 1 ? "" : "s"}); ${skipped.length} could not be made.`];
  if (skipped.length) {
    lines.push("Could not be made (the slot is as it was in the standard):");
    for (const c of skipped.slice(0, MAX_LISTED)) lines.push(`- ${c.summary} — ${c.reason ?? "no reason given"}`);
    if (skipped.length > MAX_LISTED) lines.push(`- and ${skipped.length - MAX_LISTED} more`);
  }
  return lines;
}

/**
 * The tool, with the pieces a test swaps: `apply` in place of applyDocxOps
 * (it receives { signal } as the fourth argument; the real one stops at the
 * next part and the next fallback change once the signal is aborted),
 * `applyTimeoutMs` for the deadline, `now` for the label's date. `deps` is
 * what tools.js hands every module.
 */
export function createFillStandardTools(deps, { apply = applyDocxOps, applyTimeoutMs = APPLY_TIMEOUT_MS } = {}) {
  const { supabase, helpers, writes, log = () => {} } = deps;
  const { needProject, open, link, textOfBytes } = helpers;
  const at = () => { const n = typeof deps.now === "function" ? deps.now() : Date.now(); return n instanceof Date ? n : new Date(n); };

  const needTypeId = (input) => {
    const id = uuid(input.documentTypeId);
    if (!id) throw new Error("documentTypeId must be a document type id (a UUID). list_document_types gives them.");
    return id;
  };

  /**
   * The standard's current file: the rows as open_standard_for_filling
   * reads them (fillStandard.js standardRows: the type, the
   * document_type_templates row with the path in the precedent-library
   * bucket, and the document_template_versions row with that path, the
   * pinned snapshot the site keeps — unique by path, so a replaced standard
   * is a different path and different bytes), then the file downloaded
   * afresh so the sha256 check is of the bytes as they are now. Returns the
   * bytes and what to call the file.
   */
  async function standardOf(typeId) {
    const { type, template, snapshot: pinned } = await standardRows(supabase, typeId);
    if (!template || !isWordFile(template)) throw new Error(`There is no Word standard for ${type.name} to fill; save_draft_to_project files a draft in the house format instead.`);
    const { data: blob, error } = await supabase.storage.from(STANDARDS_BUCKET).download(template.storage_path);
    if (error || !blob) throw new Error(`The standard for ${type.name} could not be downloaded${error?.message ? ` (${error.message})` : ""}; try again.`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) throw new Error(`The standard for ${type.name} is empty on the Hub; upload it again under Firm Library → Standards.`);
    return { type, drafting: draftingOf(type), bytes, pack: packOf(template), storagePath: template.storage_path, fileName: pinned?.filename ?? template.filename ?? template.storage_path.split("/").pop(), snapshotAt: pinned?.created_at ?? template.updated_at ?? null };
  }

  /** The existing document a next version goes on, checked to be on this project so the refusal is plain. */
  async function existingDocument(docId, matter) {
    const { data, error } = await supabase.from("matter_documents").select("id, title, matter_id").eq("id", docId).maybeSingle();
    if (error) throw new Error(`Could not read the document: ${error.message}`);
    if (!data) throw new Error("There is no project document with that id. list_project_documents gives them.");
    if (data.matter_id !== matter.id) throw new Error(`That document is not on ${matter.name}.`);
    return data;
  }

  /**
   * applyDocxOps under a deadline. The signal is handed to the apply
   * function, which stops at its next part or fallback change; whether or
   * not it honours it, the deadline wins and nothing is written (any work
   * it goes on doing is thrown away).
   */
  async function applyWithDeadline(bytes, ops, byRef, kinds) {
    const controller = new AbortController();
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(TOO_LONG_SENTENCE)); }, applyTimeoutMs);
    });
    try {
      return await Promise.race([apply(bytes, ops, byRef, { signal: controller.signal, ...(kinds ? { kinds } : {}) }), deadline]);
    } catch (err) {
      if (controller.signal.aborted || err?.name === "AbortError") throw new Error(TOO_LONG_SENTENCE);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return [
    {
      name: FILL_TOOL,
      title: "Fill the firm's Word standard and file it in a project",
      description: `Draft a document by filling the firm's real Word standard for a document type and filing the result as a NEW version in a project: the facts you gathered go into the standard's placeholder paragraphs as changes against the ¶n numbers from open_standard_for_filling, the fills are accepted so the draft reads clean, every value you were not given stays [●], and open questions go in as "AKLA Comments" margin comments. Numbering, styles, headers and the contents page stay as the firm set them. Use it after open_standard_for_filling and after asking the firm's drafting questions (get_drafting_decisions) one at a time; say which project and title you will file under and wait for the lawyer's yes. This is how a document of a type with a standard or pack is drafted from claude.ai: the draft is filed in the Hub, never handed over only as a file or artifact in the chat. It always saves a NEW version, never over one that exists, and claude.ai asks the lawyer before it runs; every save is recorded against the lawyer. templateHash is the fingerprint open_standard_for_filling printed: if the standard was replaced since, the fill is refused and nothing is saved. At most ${MAX_OPS} changes a call (file the rest as the next version); each must quote the paragraph's exact current text in expected, as open_standard_for_filling listed it or read it with paragraphs: "from-to", so a stale or unseen paragraph changes nothing. When the standard is one of the firm's packs, write, repeat_block, add_row and remove_block are taken too, as open_standard_for_filling describes: the body of a letter, memo or opinion, or a new clause, is written in the pack's own paragraph kinds. One fill runs on the Hub at a time; a second is refused in one sentence and can be sent again a minute later. The standard in the library is never changed. Before filing, the draft is checked against the firm's clause list for the type: a part the firm always has that the draft lacks refuses the filing and names its id; send the same changes again with confirmedOmissions only once the lawyer confirms it may be left out. A heading not on the list gets the AKLA comment "New clause — not in the firm's precedents", and each wording point in what you wrote (not the standard's own words) an AKLA comment; neither stops the filing. Returns every change that could not be made and why, the format, clause-list and wording lines, the blanks still in the file, the new version's id and its Hub page. Filing is not legal approval.`,
      ui: DOCUMENT_UI,
      inputSchema: {
        documentTypeId: z.string().describe("The document type's id, from list_document_types or open_standard_for_filling."),
        projectId: z.string().describe("The project's id, from list_projects or find_document_by_title."),
        title: z.string().describe("The title of the NEW document on the Hub, e.g. \"Concession Agreement — Hyderabad Bypass\". For a next version of an existing document the document keeps its own title; this names the file."),
        ops: z.array(z.object({
          op: z.enum(OP_KINDS).describe("replace (the whole paragraph with the fact in it), insert_after (one new paragraph after ¶p), delete, or comment (an AKLA Comments margin comment on ¶p). For a firm pack also: write (paragraphs of the pack's kinds after ¶after), repeat_block (¶from–¶to copied after ¶after), add_row (a row like the one holding ¶like_row) and remove_block (¶from–¶to removed)."),
          p: z.number().int().min(1).optional().describe("The paragraph's number ¶n from open_standard_for_filling (replace, insert_after, delete, comment)."),
          expected: z.string().max(MAX_OP_TEXT_CHARS).describe("The paragraph's exact current text, without the ¶ label: of ¶p, or for a block operation of ¶after (write), ¶from (repeat_block, remove_block) or ¶like_row (add_row)."),
          text: z.string().max(MAX_OP_TEXT_CHARS).optional().describe("replace: the complete new text of the paragraph with the fact in it, everything else word for word as it was; insert_after: the new paragraph; comment: the comment. Not for delete or the block operations."),
          after: z.number().int().min(1).optional().describe("write, repeat_block: the paragraph the new paragraphs go after."),
          from: z.number().int().min(1).optional().describe("repeat_block, remove_block: the first paragraph of the block."),
          to: z.number().int().min(1).optional().describe("repeat_block, remove_block: the last paragraph of the block."),
          table: z.number().int().min(1).optional().describe("add_row: optional, any paragraph of the same table."),
          like_row: z.number().int().min(1).optional().describe("add_row: a paragraph in the row the new row copies; it goes straight after that row."),
          blocks: z.array(z.object({
            kind: z.string().describe("One of the pack's kinds, as open_standard_for_filling listed them."),
            text: z.string().max(MAX_OP_TEXT_CHARS).optional().describe("The paragraph's text (a paragraph kind or footnote)."),
            rows: z.array(z.array(z.string().max(MAX_OP_TEXT_CHARS))).optional().describe("A table kind: the rows, each a list of cell texts; the first row is the header."),
          })).max(MAX_BLOCKS).optional().describe("write: the paragraphs to write, in order."),
          cells: z.array(z.string().max(MAX_OP_TEXT_CHARS)).max(MAX_BLOCKS).optional().describe("add_row: each cell's text, left to right."),
          why: z.string().max(MAX_WHY_CHARS).optional().describe("Optional: one short line on why."),
        })).min(1).max(MAX_OPS).describe(`The changes, at most ${MAX_OPS}.`),
        templateHash: z.string().describe("The standard's fingerprint (sha256) as open_standard_for_filling printed it."),
        confirmedOmissions: z.array(z.string()).optional().describe("Only after a refusal for a missing part, and only once the lawyer confirms it may be left out: the clause-list ids the refusal named, e.g. [\"governing_law\"]."),
        matterDocumentId: z.string().optional().describe("Optional: an existing document's id (documentId from list_project_documents) to file this as its next version. Leave out for a new document."),
        label: z.string().optional().describe("Optional: a short label for the version, e.g. \"First draft for the client\". \"Drafted from the firm's standard in claude.ai\" and the date are added."),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        const caps = await writes.checkCaps(ctx);
        let locked = false;
        try {
          // The input, refused in one sentence before anything is read.
          const typeId = needTypeId(input);
          const ops = readOps(input.ops);
          const templateHash = typeof input.templateHash === "string" && SHA256_RE.test(input.templateHash.trim()) ? input.templateHash.trim().toLowerCase() : null;
          if (!templateHash) throw new Error("templateHash must be the standard's fingerprint (a 64-character sha256) as open_standard_for_filling printed it.");
          const title = str(typeof input.title === "string" ? input.title.replace(/\s+/g, " ") : input.title, MAX_TITLE_CHARS);
          const matterDocumentId = input.matterDocumentId == null || String(input.matterDocumentId).trim() === "" ? null : uuid(input.matterDocumentId);
          if (input.matterDocumentId != null && String(input.matterDocumentId).trim() !== "" && !matterDocumentId) throw new Error("matterDocumentId must be a document id (a UUID). list_project_documents gives them.");
          const label = str(input.label, MAX_LABEL_CHARS);
          const confirmedOmissions = readConfirmed(input.confirmedOmissions);
          const matter = await needProject(input);
          const existing = matterDocumentId ? await existingDocument(matterDocumentId, matter) : null;
          if (!title && !existing) throw new Error("A title for the new document is needed, e.g. \"Concession Agreement — Hyderabad Bypass\".");

          const record = (fields) => writes.recordAction(ctx, { tool: FILL_TOOL, projectId: matter.id, ...fields }).catch((err) => { log(`${FILL_TOOL}: the record could not be written: ${err?.message ?? err}`); return null; });

          // The standard as it is now; a replaced one is refused and recorded.
          const standard = await standardOf(typeId);
          if (sha256(standard.bytes) !== templateHash) {
            await record({ documentId: matterDocumentId, outcome: "refused" });
            throw new Error(STANDARD_CHANGED_SENTENCE);
          }

          // One fill at a time (the header): the heavy section is the
          // reading, the apply and the accept.
          if (filling) {
            await record({ documentId: matterDocumentId, outcome: "refused" });
            throw new Error(BUSY_SENTENCE);
          }
          filling = true; locked = true;

          // Every paragraph addressable (no placeholders or query, an
          // unlimited budget: the plan's reading of inspectPart), a comment
          // on a paragraph the same call rewrites accepted in either
          // wording, the fill under the deadline, then born accepted:
          // only this author's changes, so comments and any revision the
          // standard itself carried stay.
          let out;
          let fileBytes;
          let inspection;
          let aligned;
          let auto = null;
          try {
            inspection = inspectDocx(standard.bytes, { budget: Infinity });
            // The firm's rules add their comments to the same pass
            // (draftChecks.js): "New clause" on a heading written without
            // it, and one per wording point in what this call wrote.
            auto = autoCommentOps({ ops, skeleton: standard.drafting.skeleton, styleSheet: standard.drafting.styleSheet, more: `check_text on the drafted text with documentTypeId ${standard.type.id} lists them all` });
            aligned = alignCommentExpectations([...ops, ...auto.ops], inspection.byRef);
            // A firm pack's kinds: what write takes its look from.
            out = await applyWithDeadline(standard.bytes, aligned, inspection.byRef, standard.pack?.kinds);
            fileBytes = out.applied > 0 ? acceptChangesBy(out.bytes, DOCX_AUTHOR) : out.bytes;
          } catch (err) {
            await record({ documentId: matterDocumentId, outcome: "failed" });
            throw err;
          } finally {
            // The upload that follows holds one file, not the churn: the
            // next lawyer's fill need not wait for it.
            filling = false; locked = false;
          }
          // The account is of the changes sent; the comments the rules added
          // are counted in their own lines below.
          const own = out.results.filter((r) => (r.i ?? 0) < ops.length);
          const account = changesLines(own);
          if (!own.some((r) => r.status === "applied")) {
            await record({ documentId: matterDocumentId, outcome: "refused" });
            throw new Error(`None of the ${ops.length} change${ops.length === 1 ? "" : "s"} could be made, so nothing was saved; the standard is unchanged. ${account.slice(2).join(" ")} Open the standard again and quote each paragraph's exact current text in expected.`);
          }

          // The format gate (formatFingerprint.js): the filled file against
          // the standard it came from. Drift is refused and nothing is
          // saved, unless FORMAT_GATE=report, when the file is saved and the
          // reply carries what differs as a warning. A header or footer line
          // this fill was asked to change (the RFP's project-name blank in
          // its running header) may change its words, not its look.
          const format = checkFormat(fileBytes, standard.bytes, { base: standard.fileName, variableParagraphs: variableLinesFor(aligned, inspection.byRef) });
          log(`${FILL_TOOL}: format ${format.result.status}${format.refused ? " (refused)" : ""}${format.result.ms != null ? ` in ${format.result.ms}ms` : ""}`);
          if (format.refused) {
            await record({ documentId: matterDocumentId, outcome: "refused" });
            throw new Error(`${format.text} The standard is unchanged.`);
          }

          // The clause list (draftChecks.js skeletonGate): a part the firm
          // always has that the draft lacks stops the filing until the lawyer
          // confirms it may be left out (confirmedOmissions) — any such part
          // for a shell pack, whose body is written here; for a form, one
          // the fill took out (one the standard itself lacks is reported).
          const clauses = skeletonGate({
            bytes: fileBytes, baseBytes: standard.bytes, skeleton: standard.drafting.skeleton, kinds: standard.pack?.kinds ?? null,
            confirmedOmissions, full: standard.pack?.mode === "shell", report: true, typeName: standard.type.name, ops, confirmHow: connectorConfirmSentence(FILL_TOOL),
          });
          if (clauses) log(`${FILL_TOOL}: clause list ${clauses.record.status}${clauses.refused ? ` (refused: ${clauses.record.blocking.join(", ")})` : ""}`);
          if (clauses?.refused) {
            await record({ documentId: matterDocumentId, outcome: "refused" });
            throw new Error(`${clauses.text} The standard is unchanged.`);
          }

          // The save, through the foundation: the upload under the site's
          // path shape and save_document_version_as as the lawyer; a
          // refusal takes the upload back, and is recorded as failed.
          const fileTitle = title ?? str(existing?.title, MAX_TITLE_CHARS) ?? standard.type.name;
          let saved;
          try {
            saved = await writes.saveVersion({
              ctx, projectId: matter.id, title: fileTitle, matterDocumentId, documentTypeId: standard.type.id,
              bytes: fileBytes, fileName: `${fileTitle}.docx`, mime: DOCX_MIME, labelVerbatim: fillLabel(label, at()),
            });
          } catch (err) {
            await record({ documentId: matterDocumentId, outcome: "failed" });
            throw err;
          }
          const recorded = await record({ documentId: saved.matterDocumentId, versionId: saved.versionId, label: saved.label, outcome: "saved" });
          const shown = saved.created ? fileTitle : str(existing?.title, MAX_TITLE_CHARS) ?? fileTitle;
          const where = saved.created ? `a new document on ${matter.name}` : `its next version on ${matter.name}`;
          const text = [
            `Drafted "${shown}" from the firm's ${standard.type.name} standard (${standard.fileName}) and filed it as v${saved.versionNumber} (${saved.fileName}), ${where}, labelled "${saved.label}".`,
            ...account,
            format.text,
            blanksLine(out.validation?.placeholders),
            ...(clauses?.line ? [clauses.line] : []),
            ...(auto?.wording.line ? [auto.wording.line] : []),
            `documentId: ${saved.matterDocumentId}`,
            `versionId: ${saved.versionId}`,
            open("version", saved.versionId),
            `Project ${matter.name} — Open in Hub: ${link("project", matter.id)}`,
            saved.note,
            ...(recorded ? [] : [UNRECORDED_LINE]),
            "The fills are accepted in the file; the AKLA Comments are margin comments for the lawyer. The standard in the library is unchanged. Filed as the lawyer's own version (not marked AI-generated), with the label saying it came from claude.ai; filing is not legal approval.",
          ].join("\n");
          // With the MCP Apps trial on, the new draft shows in the document
          // panel under the reply (documentPanel.js); a panel that cannot be
          // built never costs the lawyer the filing's reply.
          if (!ctx?.apps || !textOfBytes) return text;
          try {
            const structuredContent = documentPanelContent({
              versionId: saved.versionId, versionNumber: saved.versionNumber, title: shown, fileName: saved.fileName,
              projectName: matter.name, hubUrl: link("version", saved.versionId), text: await textOfBytes(fileBytes, saved.fileName), source: "read from the file",
            });
            return structuredContent.total ? { text, structuredContent } : text;
          } catch (err) {
            log(`${FILL_TOOL}: the document panel for ${saved.versionId} could not be built: ${err?.message ?? err}`);
            return text;
          }
        } finally {
          if (locked) filling = false;
          caps.release();
        }
      },
    },
  ];
}

export default (deps) => createFillStandardTools(deps);
