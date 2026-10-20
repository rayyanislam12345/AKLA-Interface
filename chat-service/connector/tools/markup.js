// Slice 4 of the connector: mark up a client's draft as tracked changes.
//
// The associate highlights a passage of a Hub document in the drawer beside
// claude.ai (the companion pastes the words and "versionId: <id>" into the
// chat) and says what to do: "cap liability at fees paid", "comment on this
// that the indemnity is one-sided". Three tools serve that:
//
// show_document_paragraphs (read): the Word version's paragraphs numbered
// ¶n with their exact text, found by the highlighted words (whitespace,
// curly quotes, dashes and list numbers forgiven; a passage over several
// paragraphs finds each of them) or by a ¶ range, with the operations
// protocol (docxAgent OPS_PROTOCOL) and its connector form, and a fileHash
// of the file the mark-up will be made on.
//
// apply_tracked_changes (write): the operations written into that file as
// real tracked changes by "AKLA AI" and margin comments by "AKLA Comments"
// (docxAgent applyDocxOps, the Hub's own Edit path), checked against the
// version it was made from by the format gate (formatFingerprint.js
// checkFormat), and filed as the next version of the same document with
// nothing accepted. One redline_suggestions row per change is anchored to
// the new version (versionChanges.js), so the version's Changes list in the
// Hub (POST /changes/list and /changes/decide with { versionId }) lists
// each one and accepts or rejects it in the file.
//
// make_clean_copy (write): a further version with AKLA AI's changes accepted
// and nobody else's touched, refused while a change is still undecided
// unless the lawyer says to accept them all (the Hub's cleanRefusal rule).
//
// The file a version is marked up in is its "working file"
// (versionChanges.js workingFileOf): the version's own file, or the decided
// copy kept beside it once a change has been decided in the Hub, so a
// decision is never undone by the next mark-up. The fileHash is of those
// bytes; a decision or a newer version in between refuses the mark-up in one
// sentence, and nothing is written.
//
// The write foundation's order holds (README.md): checkCaps first, the
// work, recordAction last, release() in a finally. One mark-up or clean
// copy at a time in this process, as fillStandardWrite.js fills one
// standard at a time (a long agreement read whole and rewritten is a few
// hundred MB resident). The version is the lawyer's own filing
// (is_ai_generated false, owner decision), labelled "Marked up in
// claude.ai — <date>" or "Clean copy — <date>". Node 20.

import { z } from "zod";
import { WRITE } from "../app.js";
import { MAX_RESULT_CHARS, str, uuid } from "../tools.js";
import { inspectDocx, applyDocxOps, acceptChangesBy, describeResults, OPS_PROTOCOL, DOCX_AUTHOR } from "../../docxAgent.js";
import { alignCommentExpectations } from "../../libraryTools.js";
import { checkFormat, variableLinesFor } from "../../formatFingerprint.js";
import { findRevisions, countsWith, cleanRefusal, reconcile, placementNote, codeFor, stateOf } from "../../changes.js";
import {
  workingFileOf, downloadFile, versionRows, highestRecordedVersionId, latestVersionOf, versionEditRows, carryForward, isWordPath,
} from "../../versionChanges.js";
import { readOps, sha256, MAX_OPS, MAX_OP_TEXT_CHARS, APPLY_TIMEOUT_MS, DOCX_MIME, OP_KINDS } from "./fillStandardWrite.js";
import { rangeListing, MAX_RANGE } from "./fillStandard.js";

export const SHOW_TOOL = "show_document_paragraphs";
export const MARKUP_TOOL = "apply_tracked_changes";
export const CLEAN_TOOL = "make_clean_copy";
/** How long a version's bytes and full view are kept, per stored file. */
export const FILE_CACHE_MS = 20 * 60 * 1000;
const FILE_CACHE_MAX = 4;
/** Paragraphs shown either side of the highlighted passage. */
export const CONTEXT_PARAGRAPHS = 2;
const MAX_QUERY_CHARS = 20_000;
const MAX_LABEL_CHARS = 200;
const MAX_INSTRUCTION_CHARS = 300;
const MAX_LISTED = 60;
// Room left under the wrapper's cap for the tail line and the clip note.
const PAGE_MARGIN = 400;
const SHA256_RE = /^[0-9a-f]{64}$/i;
// The number a highlighted line may start with that Word draws itself.
const LIST_LEAD = /^\s*(?:\d+(?:\.\d+)*\.?|\(?[a-z]{1,4}\)|\(?[ivxlc]{1,6}\)|[•●▪◦\-–—*])\s+/i;

export const FILE_CHANGED_SENTENCE = "The document's file has changed since it was listed (a change was decided in the Hub, or the file was replaced), so nothing was saved; call show_document_paragraphs again and redo the changes against the new listing.";
export const BUSY_SENTENCE = "Another mark-up is running on the Hub; nothing was saved. Try again in a minute with the same changes.";
export const UNRECORDED_LINE = "The save landed but could not be recorded in the Hub's log; tell the Hub's owner.";
export const TOO_LONG_SENTENCE = `The mark-up took too long (over ${Math.round(APPLY_TIMEOUT_MS / 1000)} seconds) and nothing was written; send fewer changes in one call, then the rest on the version it files.`;

/** What claude.ai must do with the listing instead of the Hub chat's fenced block. */
export const CONNECTOR_MARKUP_NOTE = `IN CLAUDE.AI: do not end your reply with the fenced block. Tell the lawyer in a sentence or two what you will change, then call ${MARKUP_TOOL} with the operations as its "ops" argument (op, p, expected, text, why), this reply's versionId and its fileHash. The {"read": …} protocol is not available here: to see other paragraphs call ${SHOW_TOOL} again with from and to (at most ${MAX_RANGE} at a time) or with query set to the words you are looking for. Only a paragraph you have seen with its ¶ number can take an operation, and expected must be its exact text as listed. Each change goes into the lawyer's own Word file as a tracked change by "AKLA AI" and each remark as an "AKLA Comments" margin comment; nothing is accepted, and the file is filed as the next version of the same document, where the lawyer accepts or rejects each change in the Hub's Changes list or in Word. Change only what the lawyer asked for; a remark ("comment on this that…") is a comment op, never new text. At most ${MAX_OPS} changes a call. If the Hub says the file changed (a different fileHash) or a newer version exists, call ${SHOW_TOOL} on the newest version and redo the changes against the new listing.`;

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Karachi" });
const n = (v) => Number(v).toLocaleString("en");
const plural = (k, one, many = `${one}s`) => (k === 1 ? one : many);

// The process-wide lock (see the header): a mark-up and a clean copy share it.
let busy = false;
/** Whether a mark-up or a clean copy is running in this process (tests). */
export const isMarking = () => busy;

// The bytes and full view of a stored file, per storage path (a decided
// copy is a new path, so a decision is never served from an old entry).
const cache = new Map();
/** Empties the cache (tests). */
export function clearMarkupCache() { cache.clear(); }

/** A label with the lawyer's own in front, within the column's width. */
function composedLabel(base, label) {
  const own = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!own) return base;
  const room = MAX_LABEL_CHARS - base.length - 2;
  return `${own.length > room ? `${own.slice(0, room - 1)}…` : own}: ${base}`;
}
/** "Marked up in claude.ai — 20 October 2026", the lawyer's label in front when given. */
export const markupLabel = (label, at = new Date()) => composedLabel(`Marked up in claude.ai — ${dateFmt.format(at)}`, label);
/** "Clean copy — 20 October 2026", the lawyer's label in front when given. */
export const cleanLabel = (label, at = new Date()) => composedLabel(`Clean copy — ${dateFmt.format(at)}`, label);

// ---------------------------------------------------------------- finding the passage

/**
 * Text as a comparison sees it: Unicode folded (NFKC), curly quotes and
 * primes straight, every dash a hyphen, every kind of space one space, zero
 * widths gone, lower case. What a browser's selection and Word's own text
 * disagree on, and nothing else.
 */
export function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// The words that carry a clause's meaning: the drafting glue every clause
// has is left out, so a loose match turns on the words that differ.
const GLUE = new Set(["the", "and", "shall", "all", "any", "for", "from", "with", "against", "this", "that", "its", "may", "under", "such", "which", "will", "are", "has", "have", "been", "not", "each", "other", "upon", "into", "their", "there", "these", "those", "than", "then", "same", "being", "where", "whether"]);
const wordsOf = (s) => normalizeText(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GLUE.has(w));

/** One part's paragraphs as a single normalised string, with where each paragraph sits in it. */
function joinedParts(inspection) {
  const parts = new Map();
  for (const r of [...inspection.byRef.values()].sort((a, b) => a.index - b.index)) {
    let p = parts.get(r.part);
    if (!p) { p = { text: "", spans: [] }; parts.set(r.part, p); }
    const t = normalizeText(r.exactText);
    if (!t) continue;
    if (p.text) p.text += " ";
    p.spans.push({ index: r.index, start: p.text.length, end: p.text.length + t.length });
    p.text += t;
  }
  return parts;
}

/** Every place `needle` sits in the joined parts, as the ¶ numbers it covers. */
function occurrences(parts, needle, limit = 5) {
  const found = [];
  if (!needle) return found;
  for (const p of parts.values()) {
    let at = p.text.indexOf(needle);
    while (at !== -1 && found.length < limit) {
      const end = at + needle.length;
      found.push(p.spans.filter((s) => s.start < end && s.end > at).map((s) => s.index));
      at = p.text.indexOf(needle, at + 1);
    }
  }
  return found;
}

/**
 * Where the highlighted words are in the version: { hits: [¶n…], how,
 * occurrences } or { hits: [] } when they are not found. Tried in order:
 * the whole passage word for word (after normalizeText), across paragraph
 * breaks; then line by line, each line without the list number Word draws
 * itself; then loosely, the paragraphs whose own words are nearly all in
 * the passage (a selection that began or ended mid-paragraph, or a passage
 * retyped). `how` says which, so the reply can say how sure it is.
 */
export function locatePassage(inspection, query) {
  const parts = joinedParts(inspection);
  const whole = normalizeText(query);
  if (!whole) return { hits: [], how: null, occurrences: 0 };
  const exact = occurrences(parts, whole);
  if (exact.length) return { hits: [...new Set(exact.flat())].sort((a, b) => a - b), how: exact.length > 1 ? "word for word, in more than one place" : "word for word", occurrences: exact.length };

  const lines = String(query).split(/\n+/).map((l) => normalizeText(l.replace(LIST_LEAD, ""))).filter((l) => l.length >= 12);
  const byLine = new Set();
  for (const line of lines) for (const o of occurrences(parts, line, 3)) for (const i of o) byLine.add(i);
  if (byLine.size) return { hits: [...byLine].sort((a, b) => a - b), how: "line by line", occurrences: 1 };

  const asked = new Set(wordsOf(query));
  if (asked.size < 3) return { hits: [], how: null, occurrences: 0 };
  const loose = [];
  for (const r of inspection.byRef.values()) {
    const own = wordsOf(r.exactText);
    if (own.length < 3) continue;
    const inside = own.filter((w) => asked.has(w)).length;
    if (inside >= 3 && inside / own.length >= 0.75) loose.push(r.index);
  }
  if (loose.length) return { hits: loose.sort((a, b) => a - b), how: "loosely, by its words (check that these are the paragraphs meant)", occurrences: 1 };
  return { hits: [], how: null, occurrences: 0 };
}

/** One listing line, as docxAgent's own listing prints a paragraph. */
const lineOf = (r) => `¶${r.index}${r.headingLevel ? ` [H${r.headingLevel}]` : ""}${r.inTable ? " [table]" : ""}${r.formatting ? " [text box]" : ""} ${r.exactText}`;
const gapLine = (ids) => `   … ${ids.length} paragraph${ids.length === 1 ? "" : "s"} not shown: ${ids.length === 1 ? `¶${ids[0]}` : `¶${ids[0]}–¶${ids[ids.length - 1]}`} …`;
/**
 * "¶12", "¶12–¶13" or "¶4, ¶9–¶10". `known` (the ¶ numbers the file has,
 * ascending) joins two paragraphs with only empty ones between them: an
 * empty paragraph has no number in the listing, so ¶255 and ¶257 read as
 * neighbours.
 */
export function paragraphRanges(ids, known = null) {
  const next = new Map();
  if (known) for (let k = 0; k < known.length - 1; k++) next.set(known[k], known[k + 1]);
  const runs = [];
  for (const i of ids) {
    const last = runs[runs.length - 1];
    if (last && (i === last[1] + 1 || next.get(last[1]) === i)) last[1] = i; else runs.push([i, i]);
  }
  return runs.map(([a, b]) => (a === b ? `¶${a}` : `¶${a}–¶${b}`)).join(", ");
}

/**
 * The hits and CONTEXT_PARAGRAPHS either side of each, part by part, the
 * nearest heading above each hit too, the rest as gaps naming their ¶
 * numbers, within `budget` characters. Returns { text, shown }.
 */
export function passageListing(inspection, hits, budget) {
  const refs = [...inspection.byRef.values()].sort((a, b) => a.index - b.index);
  const position = new Map(refs.map((r, i) => [r.index, i]));
  const keep = new Set();
  for (const h of hits) {
    const at = position.get(h);
    if (at === undefined) continue;
    const part = refs[at].part;
    for (let k = at - CONTEXT_PARAGRAPHS; k <= at + CONTEXT_PARAGRAPHS; k++) if (refs[k]?.part === part) keep.add(k);
    for (let k = at - 1; k >= 0 && refs[k].part === part; k--) if (refs[k].headingLevel) { keep.add(k); break; }
  }
  const blocks = [];
  let lines = [];
  let part = null;
  let hidden = [];
  let chars = 0;
  let shown = 0;
  const flush = () => { if (hidden.length && lines.length) lines.push(gapLine(hidden)); hidden = []; };
  const close = () => { if (lines.length) blocks.push(`PART: ${part}\n${lines.join("\n")}`); lines = []; hidden = []; };
  refs.forEach((r, i) => {
    if (r.part !== part) { close(); part = r.part; }
    if (!keep.has(i) || chars > budget) { hidden.push(r.index); return; }
    flush();
    const line = lineOf(r);
    lines.push(line);
    chars += line.length + 1;
    shown++;
  });
  close();
  return { text: blocks.join("\n\n"), shown };
}

// ---------------------------------------------------------------- the tools

/**
 * The tools, with the pieces a test swaps: `apply` in place of applyDocxOps
 * (it receives { idFloor, signal } as the fourth argument), `applyTimeoutMs`
 * for the deadline, `format` in place of checkFormat. `deps` is what
 * tools.js hands every module.
 */
export function createMarkupTools(deps, { apply = applyDocxOps, applyTimeoutMs = APPLY_TIMEOUT_MS, format = checkFormat } = {}) {
  const { supabase, helpers, writes, log = () => {} } = deps;
  const { needVersion, versionName, open, link } = helpers;
  const now = () => { const t = typeof deps.now === "function" ? deps.now() : Date.now(); return t instanceof Date ? t.getTime() : Number(t); };
  const at = () => new Date(now());
  const COLUMNS = "id, version_number, storage_path, file_name, label, created_at, matter_document_id";

  /** A Word version, or a plain sentence saying why it cannot be marked up. */
  async function wordVersion(input) {
    const v = await needVersion(input, COLUMNS);
    if (!isWordPath(v.storage_path)) {
      const kind = (/\.([a-z0-9]{1,10})$/i.exec(v.file_name ?? v.storage_path)?.[1] ?? "other").toUpperCase();
      throw new Error(`${versionName(v)} is a ${kind} file, not a Word file, so it cannot be marked up as tracked changes: read_document reads it, and save_draft_to_project files a redraft as a new version.`);
    }
    return v;
  }

  /** The version's working file, its bytes and full view (cached per stored path). */
  async function loadFile(version) {
    const file = await workingFileOf(supabase, version);
    const hit = cache.get(file.storagePath);
    if (hit && now() - hit.at < FILE_CACHE_MS) return { file, ...hit };
    if (hit) cache.delete(file.storagePath);
    const bytes = await downloadFile(supabase, file);
    let inspection;
    try { inspection = inspectDocx(bytes, { budget: Infinity }); } catch (err) {
      throw new Error(`${versionName(version)} could not be read as a Word document: ${err?.message ?? err}.`);
    }
    const entry = { at: now(), bytes, hash: sha256(bytes), inspection };
    cache.set(file.storagePath, entry);
    while (cache.size > FILE_CACHE_MAX) cache.delete(cache.keys().next().value);
    return { file, ...entry };
  }

  /** applyDocxOps under a deadline (fillStandardWrite.js's rule): the deadline wins and nothing is written. */
  async function applyWithDeadline(bytes, ops, byRef, idFloor) {
    const controller = new AbortController();
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(TOO_LONG_SENTENCE)); }, applyTimeoutMs);
    });
    try {
      return await Promise.race([apply(bytes, ops, byRef, { idFloor, signal: controller.signal }), deadline]);
    } catch (err) {
      if (controller.signal.aborted || err?.name === "AbortError") throw new Error(TOO_LONG_SENTENCE);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The stale check: the version must be its document's newest. Returns the newer version or null. */
  async function newerThan(version) {
    const latest = await latestVersionOf(supabase, version.matter_document_id);
    return latest && latest.id !== version.id ? latest : null;
  }
  const staleSentence = (version, latest) => `A newer version of ${version.matter_document?.title ?? "this document"} exists (v${latest.version_number}, versionId ${latest.id}), so nothing was saved: v${version.version_number} is no longer the one to mark up. Call ${SHOW_TOOL} on versionId ${latest.id} and redo the changes against that listing.`;

  /** One write at a time (the header); the caller releases it in a finally. */
  function lock() {
    if (busy) return false;
    busy = true;
    return true;
  }

  return [
    // ------------------------------------------------------------ show
    {
      name: SHOW_TOOL,
      title: "Show a Word document's paragraphs for a mark-up",
      description: `A Word version of a project document, opened for tracked changes: its paragraphs numbered ¶n with their exact text, found by the words the lawyer highlighted (query: paste the passage as it came; spacing, curly quotes, dashes and list numbers do not matter, and a passage over several paragraphs finds each of them) with ${CONTEXT_PARAGRAPHS} paragraphs either side and the heading above, or a range of paragraphs (from, to: at most ${MAX_RANGE} at a time; with neither, the first ${MAX_RANGE}). With the operations protocol, the versionId and a fileHash that ${MARKUP_TOOL} must echo (a file changed in between is refused). Use it when the lawyer asks for a change or a comment on a Hub document: the pasted text carries "versionId: <id>". Nothing is changed by this tool. Only Word (.docx) versions can be marked up.`,
      inputSchema: {
        versionId: z.string().describe("The Word version's id: the \"versionId:\" line the lawyer pasted with the passage, or from list_project_documents."),
        query: z.string().max(MAX_QUERY_CHARS).optional().describe("The highlighted passage, as pasted, or a few distinctive words of the clause."),
        from: z.number().int().min(1).optional().describe("Instead of a query: the first paragraph number of a range to read."),
        to: z.number().int().min(1).optional().describe(`The last paragraph number of the range (at most ${MAX_RANGE} after from).`),
      },
      async run(input) {
        const version = await wordVersion(input);
        const { file, hash, inspection } = await loadFile(version);
        const total = inspection.paragraphCount;
        const last = Math.max(0, ...inspection.byRef.keys());
        const rows = await versionRows(supabase, version.id);
        const waiting = rows.filter((r) => stateOf(r) === "waiting").length;
        const latest = await newerThan(version);
        const head = [
          `${versionName(version)} on ${version.matter_document?.matter?.name ?? "its project"} — a Word file of ${n(total)} paragraphs (¶1–¶${n(last)}).`,
          `versionId: ${version.id}`,
          `fileHash: ${hash}`,
          ...(file.decided ? ["This version has had changes decided in the Hub: the listing is of the decided copy, which is what a mark-up starts from."] : []),
          ...(waiting ? [`${waiting} AKLA AI ${plural(waiting, "change is", "changes are")} still waiting for a decision in this version's Changes list; a further mark-up keeps ${waiting === 1 ? "it" : "them"} waiting on the next version.`] : []),
          ...(latest ? [`Note: this is not the newest version: v${latest.version_number} (versionId ${latest.id}) is. ${MARKUP_TOOL} marks up only the newest version, so call ${SHOW_TOOL} on that one before changing anything.`] : []),
          open("version", version.id),
          "",
          OPS_PROTOCOL,
          "",
          CONNECTOR_MARKUP_NOTE,
        ];
        const query = typeof input.query === "string" && input.query.trim() ? input.query : null;
        if (query) {
          const found = locatePassage(inspection, query);
          const headText = head.join("\n");
          const budget = Math.max(2_000, MAX_RESULT_CHARS - headText.length - PAGE_MARGIN);
          if (!found.hits.length) {
            return `${headText}\n\nThe highlighted words were not found in this version. Read the paragraphs by number (from, to) or search with a few distinctive words of the clause. The headings, to find the clause by:\n${passageListing(inspection, [...inspection.byRef.values()].filter((r) => r.headingLevel).map((r) => r.index), budget).text || "(this file has no headings)"}`;
          }
          const where = `The highlighted passage is ${paragraphRanges(found.hits, [...inspection.byRef.keys()].sort((a, b) => a - b))}, found ${found.how}.${found.occurrences > 1 ? ` The words occur ${found.occurrences} times; ask the lawyer which is meant if it matters.` : ""}`;
          const listing = passageListing(inspection, found.hits, budget);
          return `${headText}\n\n${where}\n\nPARAGRAPHS:\n${listing.text}`;
        }
        const from = Number.isInteger(input.from) && input.from > 0 ? input.from : 1;
        const askedTo = Number.isInteger(input.to) && input.to >= from ? input.to : from + MAX_RANGE - 1;
        const to = Math.min(askedTo, from + MAX_RANGE - 1);
        if (from > last) return `${head.slice(0, 3).join("\n")}\nThere is no ¶${n(from)}: the paragraphs run ¶1–¶${n(last)}.`;
        const headText = head.join("\n");
        const page = rangeListing(inspection, { from, to }, Math.max(2_000, MAX_RESULT_CHARS - headText.length - PAGE_MARGIN));
        if (!page.count) return `${headText}\n\nThere is no paragraph with text between ¶${n(from)} and ¶${n(to)}.`;
        const next = page.more ? page.last + 1 : to < last ? to + 1 : null;
        const tail = next
          ? `[${page.more ? `Stopped at ¶${n(page.last)} to stay under the size limit` : askedTo > to ? `The range was cut to ${MAX_RANGE} paragraphs` : "The document goes on"}: call ${SHOW_TOOL} again with from: ${next}, to: ${Math.min(next + MAX_RANGE - 1, last)}.]`
          : "[The document ends here.]";
        return `${headText}\n\nPARAGRAPHS ¶${n(from)}–¶${n(page.last)}:\n${page.text}\n\n${tail}`;
      },
    },

    // ------------------------------------------------------------ mark up
    {
      name: MARKUP_TOOL,
      title: "Mark up a Word document as tracked changes",
      description: `Write changes into a project's Word document as real tracked changes by "AKLA AI" (and remarks as "AKLA Comments" margin comments), in the lawyer's own file, and file the result as the NEXT version of the same document; nothing is accepted, and the lawyer accepts or rejects each change in the Hub's Changes list beside the chat or in Word. Styles, numbering, tables and headers stay as they are. Use it after ${SHOW_TOOL}, with the ¶ numbers, the exact paragraph text and the fileHash it printed; say what you will change and wait for the lawyer's yes. It always saves a NEW version, never over one, and claude.ai asks the lawyer before it runs; every save is recorded against the lawyer. Refused, with nothing saved, if the file changed since it was listed (a different fileHash), if a newer version of the document exists, or if the result's format differs from the version it was made from. At most ${MAX_OPS} changes a call; each must quote its paragraph's exact current text in expected, so a stale listing changes nothing. One mark-up runs on the Hub at a time. Returns each change made, each that could not be made and why, the new version's id and its Hub page. Filing is not legal approval.`,
      inputSchema: {
        versionId: z.string().describe(`The version ${SHOW_TOOL} listed.`),
        ops: z.array(z.object({
          op: z.enum(OP_KINDS).describe("replace (the paragraph's complete new text), insert_after (one new paragraph after ¶p), delete, or comment (an AKLA Comments margin comment on ¶p, its text unchanged)."),
          p: z.number().int().min(1).describe(`The paragraph's number ¶n from ${SHOW_TOOL}.`),
          expected: z.string().max(MAX_OP_TEXT_CHARS).describe("The paragraph's exact current text, without the ¶ label."),
          text: z.string().max(MAX_OP_TEXT_CHARS).optional().describe("replace: the complete new paragraph, everything not changed word for word as it was; insert_after: the new paragraph; comment: the remark. Not for delete."),
          why: z.string().max(MAX_INSTRUCTION_CHARS).optional().describe("Optional: one short line on why, shown beside the change in the Changes list."),
        })).min(1).max(MAX_OPS).describe(`The changes, at most ${MAX_OPS}.`),
        fileHash: z.string().describe(`The fileHash ${SHOW_TOOL} printed.`),
        label: z.string().optional().describe("Optional: a short label for the new version, e.g. \"Our comments on the client's draft\". \"Marked up in claude.ai\" and the date are added."),
        instruction: z.string().max(MAX_INSTRUCTION_CHARS).optional().describe("Optional: the lawyer's instruction in a line (\"cap liability at fees paid\"); shown as the reason of any change sent without its own why."),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        const caps = await writes.checkCaps(ctx);
        let locked = false;
        const started = now();
        try {
          if (!Array.isArray(input.ops) || !input.ops.length) throw new Error(`ops must be a list of at least one change ({ op, p, expected, text, why }), as ${SHOW_TOOL} describes.`);
          if (input.ops.length > MAX_OPS) throw new Error(`${MARKUP_TOOL} takes at most ${MAX_OPS} changes in one call (${input.ops.length} were sent); send the first ${MAX_OPS} now and the rest on the version it files.`);
          const instruction = str(typeof input.instruction === "string" ? input.instruction.replace(/\s+/g, " ") : null, MAX_INSTRUCTION_CHARS);
          const ops = readOps(input.ops).map((op) => (op.why || !instruction ? op : { ...op, why: instruction }));
          const fileHash = typeof input.fileHash === "string" && SHA256_RE.test(input.fileHash.trim()) ? input.fileHash.trim().toLowerCase() : null;
          if (!fileHash) throw new Error(`fileHash must be the file's fingerprint (a 64-character sha256) as ${SHOW_TOOL} printed it.`);
          const label = str(input.label, MAX_LABEL_CHARS);
          const version = await wordVersion(input);
          const doc = version.matter_document;
          const matter = doc.matter;
          const record = (fields) => writes.recordAction(ctx, { tool: MARKUP_TOOL, projectId: matter.id, documentId: doc.id, ...fields }).catch((err) => { log(`${MARKUP_TOOL}: the record could not be written: ${err?.message ?? err}`); return null; });

          // A stale mark-up (someone filed a newer version), then a changed
          // file (a decision in the Hub, or the stored file replaced).
          const latest = await newerThan(version);
          if (latest) { await record({ versionId: version.id, outcome: "refused" }); throw new Error(staleSentence(version, latest)); }
          const { file, bytes, hash } = await loadFile(version);
          if (hash !== fileHash) { await record({ versionId: version.id, outcome: "refused" }); throw new Error(FILE_CHANGED_SENTENCE); }

          if (!lock()) { await record({ versionId: version.id, outcome: "refused" }); throw new Error(BUSY_SENTENCE); }
          locked = true;

          // Every paragraph addressable (an unlimited budget: the ¶ numbers
          // the listing printed), a comment quoting a paragraph the same
          // call rewrites accepted in either wording, the changes under the
          // deadline with ids above every id this document has used.
          let out, inspection, aligned;
          const t0 = now();
          try {
            inspection = inspectDocx(bytes, { budget: Infinity });
            aligned = alignCommentExpectations(ops, inspection.byRef);
            const idFloor = Math.max(9000, await highestRecordedVersionId(supabase, doc.id));
            out = await applyWithDeadline(bytes, aligned, inspection.byRef, idFloor);
          } catch (err) {
            await record({ versionId: version.id, outcome: "failed" });
            throw err;
          } finally {
            busy = false; locked = false;
          }
          const applyMs = now() - t0;
          const described = describeResults(out.results);
          const made = described.filter((c) => c.status === "applied");
          const notMade = described.filter((c) => c.status !== "applied");
          if (out.applied === 0) {
            await record({ versionId: version.id, outcome: "refused" });
            const why = notMade.slice(0, 5).map((c) => `${c.summary} — ${placementNote(codeFor(c.reason)) ?? c.reason}`).join("; ");
            throw new Error(`None of the ${ops.length} ${plural(ops.length, "change")} could be made, so nothing was saved: ${why}. Call ${SHOW_TOOL} again and quote each paragraph's exact current text in expected.`);
          }

          // The format gate against the version it was made from: drift is
          // refused and nothing is saved (FORMAT_GATE=report saves it with
          // the list as a warning). The tracked changes stay tracked.
          const gate = format(out.bytes, bytes, { base: file.fileName, subject: "the version it was made from", variableParagraphs: variableLinesFor(aligned, inspection.byRef) });
          log(`${MARKUP_TOOL}: format ${gate.result.status}${gate.refused ? " (refused)" : ""}${gate.result.ms != null ? ` in ${gate.result.ms}ms` : ""}`);
          if (gate.refused) {
            await record({ versionId: version.id, outcome: "refused" });
            throw new Error(`${gate.text} v${version.version_number} is unchanged.`);
          }

          // The file must still be the one marked up: a decision in the Hub
          // during the work moves the working file on.
          const now2 = await workingFileOf(supabase, version);
          if (now2.storagePath !== file.storagePath) { await record({ versionId: version.id, outcome: "refused" }); throw new Error(FILE_CHANGED_SENTENCE); }

          let saved;
          try {
            saved = await writes.saveVersion({
              ctx, projectId: matter.id, title: doc.title, matterDocumentId: doc.id, expectedVersion: version.id,
              bytes: out.bytes, fileName: `${doc.title}.docx`, mime: DOCX_MIME,
              labelVerbatim: markupLabel(label, at()),
            });
          } catch (err) {
            await record({ versionId: version.id, outcome: "failed" });
            throw err;
          }

          // The Changes list of the new version: the earlier version's
          // waiting changes carried over (their revisions are in this file),
          // then one row per change made now, then what this mark-up did to
          // the carried ones (a rewrite of an AI insertion takes it over).
          const rowsLine = await recordRows({ supabase, version, saved, bytes: out.bytes, results: out.results, userId: ctx.userId, log });
          const recorded = await record({ versionId: saved.versionId, label: saved.label, outcome: "saved" });
          log(`${MARKUP_TOOL}: v${version.version_number} → v${saved.versionNumber} of ${doc.id}: ${made.length} made, ${notMade.length} not, apply ${applyMs}ms, total ${now() - started}ms`);

          const comments = made.filter((c) => c.op === "comment").length;
          const lines = [
            `Marked up "${doc.title}" v${version.version_number} and filed it as v${saved.versionNumber} (${saved.fileName}), the next version of the document on ${matter.name}, labelled "${saved.label}".`,
            `Changes: ${made.length} of ${described.length} made — ${made.length - comments} as ${plural(made.length - comments, "tracked change")} by AKLA AI, ${comments} ${plural(comments, "margin comment")} by AKLA Comments; ${notMade.length} could not be made.`,
            ...made.slice(0, MAX_LISTED).map((c) => `- ${c.summary}`),
            ...(made.length > MAX_LISTED ? [`- and ${made.length - MAX_LISTED} more`] : []),
          ];
          if (notMade.length) {
            lines.push("Could not be made (nothing changed there):");
            for (const c of notMade.slice(0, MAX_LISTED)) lines.push(`- ${c.summary} — ${placementNote(codeFor(c.reason)) ?? c.reason ?? "no reason given"}`);
            if (notMade.length > MAX_LISTED) lines.push(`- and ${notMade.length - MAX_LISTED} more`);
          }
          lines.push(
            gate.text,
            rowsLine,
            `documentId: ${doc.id}`,
            `versionId: ${saved.versionId}`,
            open("version", saved.versionId),
            `Project ${matter.name} — Open in Hub: ${link("project", matter.id)}`,
            ...(recorded ? [] : [UNRECORDED_LINE]),
            `Nothing was accepted: v${saved.versionNumber} carries the changes as tracked changes, and v${version.version_number} is unchanged. Filed as the lawyer's own version (not marked AI-generated), with the label saying it came from claude.ai; filing is not legal approval. When the changes are decided, ${CLEAN_TOOL} files a clean copy.`,
          );
          return lines.join("\n");
        } finally {
          if (locked) busy = false;
          caps.release();
        }
      },
    },

    // ------------------------------------------------------------ clean copy
    {
      name: CLEAN_TOOL,
      title: "File a clean copy of a marked-up document",
      description: `File a clean copy of a marked-up Word version as the NEXT version of the same document: AKLA AI's tracked changes accepted as the lawyer decided them in the Hub (a change rejected there stays out), every other person's tracked changes and every margin comment left as they are. Refused while a change in the version's Changes list is still waiting for a decision, unless the lawyer says to accept them all as they stand (acceptAll: true); refused if a newer version exists or if the clean copy's format differs from the version. Only when the lawyer asks for it. It always saves a NEW version, never over one, and claude.ai asks the lawyer before it runs; every save is recorded against the lawyer.`,
      inputSchema: {
        versionId: z.string().describe(`The marked-up version (the one ${MARKUP_TOOL} filed, or its newest).`),
        acceptAll: z.boolean().optional().describe("Only when the lawyer says so: accept every AKLA AI change still waiting, as it stands, and record them as accepted by the lawyer."),
        label: z.string().optional().describe("Optional: a short label, e.g. \"For the client\". \"Clean copy\" and the date are added."),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        const caps = await writes.checkCaps(ctx);
        let locked = false;
        try {
          const acceptAll = input.acceptAll === true;
          const label = str(input.label, MAX_LABEL_CHARS);
          const version = await wordVersion(input);
          const doc = version.matter_document;
          const matter = doc.matter;
          const record = (fields) => writes.recordAction(ctx, { tool: CLEAN_TOOL, projectId: matter.id, documentId: doc.id, ...fields }).catch((err) => { log(`${CLEAN_TOOL}: the record could not be written: ${err?.message ?? err}`); return null; });

          const latest = await newerThan(version);
          if (latest) { await record({ versionId: version.id, outcome: "refused" }); throw new Error(staleSentence(version, latest)); }
          const { file, bytes } = await loadFile(version);
          const rows = await versionRows(supabase, version.id);
          const revisions = findRevisions(bytes);
          const counts = countsWith(rows, revisions);
          // The Hub's rule, for AKLA AI's changes only: other people's
          // revisions are left in the file, so they never stop it.
          const refusal = acceptAll ? null : cleanRefusal({ ...counts, othersRevisions: 0 }, false);
          if (refusal) {
            await record({ versionId: version.id, outcome: "refused" });
            throw new Error(`${refusal} Nothing was filed. When the lawyer wants every AKLA AI change accepted as it stands, call ${CLEAN_TOOL} again with acceptAll: true.`);
          }
          if (!revisions.ours.size && !file.decided) {
            await record({ versionId: version.id, outcome: "refused" });
            throw new Error(`${versionName(version)} has no AKLA AI tracked changes to accept, so a clean copy would be the same file; nothing was filed.`);
          }

          if (!lock()) { await record({ versionId: version.id, outcome: "refused" }); throw new Error(BUSY_SENTENCE); }
          locked = true;
          let clean;
          try {
            clean = revisions.ours.size ? acceptChangesBy(bytes, DOCX_AUTHOR) : bytes;
          } catch (err) {
            await record({ versionId: version.id, outcome: "failed" });
            throw err;
          } finally {
            busy = false; locked = false;
          }
          const gate = format(clean, bytes, { base: file.fileName, subject: "the version it was made from" });
          log(`${CLEAN_TOOL}: format ${gate.result.status}${gate.refused ? " (refused)" : ""}`);
          if (gate.refused) {
            await record({ versionId: version.id, outcome: "refused" });
            throw new Error(`${gate.text} v${version.version_number} is unchanged.`);
          }

          let saved;
          try {
            saved = await writes.saveVersion({
              ctx, projectId: matter.id, title: doc.title, matterDocumentId: doc.id, expectedVersion: version.id,
              bytes: clean, fileName: `${doc.title}.docx`, mime: DOCX_MIME,
              labelVerbatim: cleanLabel(label, at()),
            });
          } catch (err) {
            await record({ versionId: version.id, outcome: "failed" });
            throw err;
          }
          // The changes accepted on the lawyer's word are recorded as theirs.
          const undecided = rows.filter((r) => r.status === "pending" && (r.placement === "placed" || r.placement === "blocked")).map((r) => r.id);
          let decidedLine = null;
          if (acceptAll && undecided.length) {
            const { error } = await supabase.from("redline_suggestions").update({ status: "accepted", decided_by: ctx.userId, decided_at: at().toISOString() }).in("id", undecided);
            decidedLine = error
              ? `The ${undecided.length} ${plural(undecided.length, "change")} accepted here could not be marked accepted in v${version.version_number}'s Changes list (${error.message}).`
              : `${undecided.length} ${plural(undecided.length, "change")} still waiting ${undecided.length === 1 ? "was" : "were"} accepted as ${undecided.length === 1 ? "it stood" : "they stood"}, recorded as the lawyer's decision.`;
            if (error) log(`${CLEAN_TOOL}: the accepted rows could not be marked: ${error.message}`);
          }
          const recorded = await record({ versionId: saved.versionId, label: saved.label, outcome: "saved" });
          const decided = counts.accepted + counts.rejected;
          return [
            `Filed a clean copy of "${doc.title}" v${version.version_number} as v${saved.versionNumber} (${saved.fileName}), labelled "${saved.label}".`,
            revisions.ours.size
              ? `AKLA AI's ${revisions.ours.size === 1 ? "change in the file is" : "changes in the file are"} accepted${decided ? `, on top of the ${decided} decided in the Hub (${counts.accepted} accepted, ${counts.rejected} rejected and left out)` : ""}.`
              : `Every AKLA AI change was decided in the Hub (${counts.accepted} accepted, ${counts.rejected} rejected and left out); this is that decided copy.`,
            ...(decidedLine ? [decidedLine] : []),
            revisions.others ? `${revisions.others} tracked ${plural(revisions.others, "change")} by other people ${revisions.others === 1 ? "is" : "are"} left as ${revisions.others === 1 ? "it was" : "they were"}, for the lawyer to decide in Word.` : "No one else's tracked changes were in the file.",
            "Margin comments stay; remove them in Word before the copy goes out.",
            gate.text,
            `documentId: ${doc.id}`,
            `versionId: ${saved.versionId}`,
            open("version", saved.versionId),
            ...(recorded ? [] : [UNRECORDED_LINE]),
            "Filed as the lawyer's own version (not marked AI-generated); filing is not legal approval.",
          ].join("\n");
        } finally {
          if (locked) busy = false;
          caps.release();
        }
      },
    },
  ];
}

/**
 * The new version's change rows, written after the save (the rows need its
 * id): the source version's waiting changes carried forward, then one row
 * per text change made now (versionChanges.js), then reconcile's account of
 * the carried ones this mark-up rewrote or withdrew. Returns the reply's
 * line. A failure here is said, never thrown: the version is filed and its
 * changes are in the file, decidable in Word.
 */
async function recordRows({ supabase, version, saved, bytes, results, userId, log }) {
  try {
    const earlier = await versionRows(supabase, version.id);
    const { clones, carried } = carryForward(earlier, { toVersionId: saved.versionId, toVersionNumber: saved.versionNumber });
    const { rows } = versionEditRows(results, { versionId: saved.versionId, userId });
    const all = [...clones, ...rows];
    if (all.length) {
      const { data, error } = await supabase.from("redline_suggestions").insert(all).select("id");
      if (error) throw new Error(error.message);
      const confirmed = new Set((data ?? []).map((r) => r.id));
      // A change made now carries its row's id, so reconcile can name the
      // row that took an earlier change over.
      const textResults = results.filter((r) => ["replace", "insert_after", "delete"].includes(String(r.kind ?? "").toLowerCase()) && !(r.status === "applied" && r.removedIds?.length && !r.revisionIds?.length));
      if (textResults.length === rows.length) textResults.forEach((r, k) => { if (confirmed.has(rows[k].id)) r.rowId = rows[k].id; });
    }
    for (const { id, patch } of carried) await supabase.from("redline_suggestions").update(patch).eq("id", id);
    // A carried change this mark-up rewrote is "Replaced by change N", one
    // it withdrew is "Withdrawn", in the new version's list.
    const overtaken = clones.length ? reconcile(bytes, clones, results) : [];
    for (const { id, patch } of overtaken) await supabase.from("redline_suggestions").update(patch).eq("id", id);
    const gone = new Set(overtaken.filter((p) => p.patch.placement).map((p) => p.id));
    const waiting = rows.filter((r) => r.placement === "placed").length + clones.filter((c) => !gone.has(c.id)).length;
    const parts = [`${waiting} ${plural(waiting, "change is", "changes are")} waiting in v${saved.versionNumber}'s Changes list in the Hub: accept or reject each there (the document window beside the chat) or in Word. Margin comments are not in the list; they stay in the file.`];
    if (clones.length) parts.push(`${clones.length} of the changes still waiting on v${version.version_number} ${clones.length === 1 ? "was" : "were"} carried forward to this version${gone.size ? `, ${gone.size} of them overtaken by this mark-up` : ""}.`);
    return parts.join(" ");
  } catch (err) {
    log(`${MARKUP_TOOL}: the change rows for ${saved.versionId} could not be written: ${err?.message ?? err}`);
    return `The changes are in the file, but the Hub could not list them in v${saved.versionNumber}'s Changes list (${err?.message ?? err}); accept or reject them in Word, and tell the Hub's owner.`;
  }
}

export default (deps) => createMarkupTools(deps);
