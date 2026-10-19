// open_standard_for_filling: the firm's Word standard for a document type,
// opened for a lawyer's claude.ai the way the Hub's own "draft from the
// standard" turn opens it (server.js: the document_type_templates row's
// .docx in precedent-library, read with docxAgent inspectDocx), so Claude
// sees the paragraphs with a blank in them, numbered ¶n with their exact
// text, every heading, and the paragraphs around each blank, and can write
// the fill as operations against those numbers. The reply carries the Hub's
// own fill instructions (firmRules.js FILL_INSTRUCTIONS, the words server.js
// prompts with), the ops protocol (docxAgent.js OPS_PROTOCOL) and a sha256
// of the file, "templateHash", which fill_standard_to_project (slice 3.2,
// its own module) must echo: a standard replaced between the open and the
// fill has a different hash and the fill is refused.
//
// The listing is composed here from inspectDocx's full view (budget
// Infinity: every paragraph, the same ¶ numbers 3.2 resolves against) rather
// than from the Hub's budgeted placeholder view: a standard the size of the
// Concession Agreement (over two thousand paragraphs) does not fit the Hub's
// 120,000-character listing, and a blank left in a "not shown" gap could
// never be filled from claude.ai. Here every heading, every paragraph with a
// blank and its neighbours go in whatever the length (paging with `from`
// handles the size), each gap names the ¶ numbers it hides, and
// `paragraphs: "from-to"` reads any range of the standard (at most
// MAX_RANGE at a time, the Hub's own read-protocol cap) so a change the
// fill instructions ask for inside a gap, a bracketed alternative to drop or
// an optional block to remove, can quote the paragraph exactly.
//
// The standard is read where server.js reads it (document_type_templates by
// document type → storage_path), and the document_template_versions row
// for that path, the immutable snapshot the Hub pins an older thread to
// (20260918090100), is named in the reply so the lawyer can see which
// filing of the standard this is. The bytes, their full view and the
// composed listing are kept twenty minutes per storage path (a replaced
// standard is a new path, 20260918090100:5, so it is never served from the
// old entry). The row lookup (`standardRows`) is shared with 3.2, which
// reads the file afresh rather than from this cache so its sha256 check
// sees the bytes as they are now. Nothing here writes: the standard in the
// library is never touched.

import { z } from "zod";
import { inspectDocx, OPS_PROTOCOL } from "../../docxAgent.js";
import { FILL_INSTRUCTIONS, FILL_DIRECT_NOTE } from "../../firmRules.js";
import { MAX_RESULT_CHARS, str, uuid, when } from "../tools.js";
import { openStandard } from "./standards.js";

export const BUCKET = "precedent-library";
/** How long a standard's bytes and listing are kept, per storage path. */
export const STANDARD_CACHE_MS = 20 * 60 * 1000;
// A few standards at a time: each is a whole Word file plus every paragraph
// of it twice (the full view and the composed listing).
const STANDARD_CACHE_MAX = 4;
/** The most paragraphs one `paragraphs: "from-to"` read returns (server.js's read protocol serves the same). */
export const MAX_RANGE = 200;
const MAX_RULES_CHARS = 4_000;
// Room left under the wrapper's cap for the continuation line and the clip note.
const PAGE_MARGIN = 400;
// docxAgent.js's rule for a blank waiting to be filled.
const PLACEHOLDER = /\[[^\]\n]{0,120}\]|_{3,}/;
// The notes parts: bracketed text there is the firm's drafting notes
// ("[Drafting Note] …" footnotes in the Concession Agreement), not a slot.
const NOTES_PART = /^word\/(footnotes|endnotes)\.xml$/;
const RANGE_RE = /^\s*¶?\s*(\d{1,7})\s*(?:[-–—]\s*¶?\s*(\d{1,7}))?\s*$/;

/** What claude.ai must do with the listing instead of the Hub chat's fenced block. */
export const CONNECTOR_FILL_NOTE = `IN CLAUDE.AI: do not end your reply with the fenced block. The order is: read the project's documents (search_project_documents, read_document) and, when this type has a drafting questionnaire, call get_drafting_decisions and ask the lawyer each decision in prose, one at a time, waiting for the answer; only then call fill_standard_to_project with the operations as its "ops" argument (op, p, expected, text, why), the project, a title and this reply's templateHash. The sentence "Do not stop to ask the lawyer before filling in" in the fill instructions is about the fill call itself, once the decisions are answered and the project's documents are read; it does not cover the drafting decisions. The {"read": …} protocol is not available here: a paragraph behind a "… not shown …" line (each names the ¶ numbers it hides) is read by calling open_standard_for_filling with paragraphs set to a range such as "100-140" (at most ${MAX_RANGE} at a time); from pages this listing only and never reaches a hidden paragraph. Only a paragraph you have seen with its ¶ number can take an operation, and expected must be its exact text. Only "replace" and "comment" fill a standard; use insert_after and delete only where the standard's own wording calls for a block to be added or removed (a bracketed alternative to drop, an optional block to keep or remove), reading the paragraphs first. At most 300 changes a call; file the rest as the next version of the same document. If the Hub says the standard was replaced (a different templateHash), open it again and redo the fill against the new listing.`;

export const isWordFile = (row) => /\.docx$/i.test(row?.storage_path ?? "");

// The cache is shared by every module in the process, keyed by storage path.
const cache = new Map();
/** Empties the cache (tests). */
export function clearStandardCache() { cache.clear(); }

/**
 * The rows that locate a type's standard, read the way server.js reads
 * them: { type, template, snapshot }, `template` null when the type has no
 * standard, `snapshot` (the pinned document_template_versions row for the
 * same path) null when the template is not a Word file or has no filing.
 * Throws a plain sentence when the type does not exist or a read fails.
 * fillStandardWrite.js reads through this too.
 */
export async function standardRows(supabase, documentTypeId) {
  const { data: type, error: typeError } = await supabase.from("document_types").select("id, name, category, questionnaire").eq("id", documentTypeId).maybeSingle();
  if (typeError) throw new Error(`Could not read the document type: ${typeError.message}`);
  if (!type) throw new Error("There is no document type with that id. list_document_types gives them.");
  // Only what locates the file: content_html is the whole standard as HTML
  // for a type that has a Word file too, megabytes nothing here reads.
  const { data: template, error: templateError } = await supabase
    .from("document_type_templates")
    .select("format_rules, storage_path, filename, updated_at")
    .eq("document_type_id", type.id)
    .maybeSingle();
  if (templateError) throw new Error(`Could not read the standard: ${templateError.message}`);
  if (!template || !isWordFile(template)) return { type, template: template ?? null, snapshot: null };
  // The immutable filing of this very file, when the Hub has one.
  const { data: snapshot, error: snapshotError } = await supabase
    .from("document_template_versions")
    .select("id, created_at, filename")
    .eq("storage_path", template.storage_path)
    .eq("document_type_id", type.id)
    .maybeSingle();
  if (snapshotError) throw new Error(`Could not read the standard's version: ${snapshotError.message}`);
  return { type, template, snapshot: snapshot ?? null };
}

/** One listing line, as docxAgent's own listing prints a paragraph. */
const lineOf = (r) => `¶${r.index}${r.headingLevel ? ` [H${r.headingLevel}]` : ""}${r.inTable ? " [table]" : ""}${r.formatting ? " [text box]" : ""} ${r.exactText}`;
const gapLine = (ids) => `   … ${ids.length} paragraph${ids.length === 1 ? "" : "s"} not shown: ${ids.length === 1 ? `¶${ids[0]}` : `¶${ids[0]}–¶${ids[ids.length - 1]}`} …`;

/** The full view's paragraphs grouped by part, in the view's order. */
function partsOf(inspection) {
  const parts = new Map();
  for (const r of inspection.byRef.values()) {
    if (!parts.has(r.part)) parts.set(r.part, []);
    parts.get(r.part).push(r);
  }
  return parts;
}

/**
 * The placeholder listing from a full inspectDocx view (budget Infinity):
 * every heading, every paragraph with a blank and the paragraph before and
 * after it, part by part as docxAgent lists them, the rest as gaps naming
 * their ¶ numbers. No character cap: the pages carry the length. Returns
 * { listing, shown }.
 */
export function fillListing(inspection) {
  const blocks = [];
  let shown = 0;
  for (const [part, refs] of partsOf(inspection)) {
    const keep = new Set();
    refs.forEach((r, i) => {
      if (r.headingLevel) keep.add(i);
      if (PLACEHOLDER.test(r.exactText)) for (const k of [i - 1, i, i + 1]) if (k >= 0 && k < refs.length) keep.add(k);
    });
    const lines = [];
    let hidden = [];
    const flush = () => { if (hidden.length) { lines.push(gapLine(hidden)); hidden = []; } };
    refs.forEach((r, i) => {
      if (!keep.has(i)) { hidden.push(r.index); return; }
      flush();
      lines.push(lineOf(r));
      shown++;
    });
    flush();
    if (keep.size) blocks.push(`PART: ${part}\n${lines.join("\n")}`);
  }
  return { listing: blocks.join("\n\n"), shown };
}

/**
 * How many paragraphs hold a blank: `body` in the document, headers and
 * footers (the slots a fill is for), `notes` in the footnotes and endnotes
 * (the firm's drafting notes, which stay for the drafter).
 */
export function blankCounts(inspection) {
  let body = 0;
  let notes = 0;
  for (const r of inspection.byRef.values()) {
    if (!PLACEHOLDER.test(r.exactText)) continue;
    if (NOTES_PART.test(r.part)) notes++; else body++;
  }
  return { body, notes };
}

/**
 * `paragraphs` as given ("100-140", "¶100–¶140", "120") → { from, to } or
 * null when it is not a range. `to` is cut to MAX_RANGE paragraphs from
 * `from`, the way the Hub's read protocol cuts a wide request.
 */
export function parseRange(value) {
  const m = RANGE_RE.exec(String(value ?? ""));
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from < 1 || to < from) return null;
  return { from, to: Math.min(to, from + MAX_RANGE - 1), cut: to > from + MAX_RANGE - 1 };
}

/**
 * The paragraphs ¶from–¶to of the full view, part by part, within
 * `budget` characters: { text, last, count, more } where `last` is the
 * last ¶ printed, `more` true when the budget stopped the read before `to`.
 */
export function rangeListing(inspection, { from, to }, budget) {
  const blocks = [];
  let lines = [];
  let part = null;
  let chars = 0;
  let last = null;
  let count = 0;
  let more = false;
  const close = () => { if (lines.length) blocks.push(`PART: ${part}\n${lines.join("\n")}`); lines = []; };
  for (let n = from; n <= to; n++) {
    const r = inspection.byRef.get(n);
    if (!r) continue;
    const line = lineOf(r);
    const cost = line.length + 1 + (r.part === part ? 0 : r.part.length + 10);
    if (count && chars + cost > budget) { more = true; break; }
    if (r.part !== part) { close(); part = r.part; }
    lines.push(line);
    chars += cost;
    last = n;
    count++;
  }
  close();
  return { text: blocks.join("\n\n"), last, count, more };
}

/**
 * The reader of a type's standard: `load(documentTypeId)` gives
 * { type, template, snapshot, bytes, hash, inspection, listing, shown,
 * blanks } — `template` null when the type has none, the rest null when it
 * is not a Word file; throws a plain sentence when the type does not exist
 * or the file cannot be read. `inspection` is inspectDocx(bytes, { budget:
 * Infinity }), every paragraph with the ¶ numbers 3.2 resolves against;
 * `listing` is fillListing's composition of it.
 */
export function createStandardLoader({ supabase, now = () => Date.now() }) {
  const cached = (path) => {
    const hit = cache.get(path);
    if (!hit) return undefined;
    if (now() - hit.at >= STANDARD_CACHE_MS) { cache.delete(path); return undefined; }
    return hit;
  };

  async function download(path) {
    const { data, error } = await supabase.storage.from(BUCKET).download(path);
    if (error || !data) throw new Error(`Could not open the standard's file: ${error?.message ?? "download failed"}.`);
    return data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
  }

  async function load(documentTypeId) {
    const { type, template, snapshot } = await standardRows(supabase, documentTypeId);
    if (!template || !isWordFile(template)) return { type, template, snapshot: null, bytes: null, hash: null, inspection: null, listing: null, shown: 0, blanks: null };
    let hit = cached(template.storage_path);
    if (!hit) {
      const bytes = await download(template.storage_path);
      let inspection;
      try { inspection = inspectDocx(bytes, { budget: Infinity }); } catch (err) {
        throw new Error(`The standard's file ${template.filename ?? template.storage_path} could not be read as a Word document: ${err?.message ?? err}.`);
      }
      const { listing, shown } = fillListing(inspection);
      hit = { at: now(), bytes, hash: inspection.hash, inspection, listing, shown, blanks: blankCounts(inspection) };
      cache.set(template.storage_path, hit);
      while (cache.size > STANDARD_CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return { type, template, snapshot, bytes: hit.bytes, hash: hit.hash, inspection: hit.inspection, listing: hit.listing, shown: hit.shown, blanks: hit.blanks };
  }

  return { load };
}

/**
 * One page of the listing from character `from`: { text, end } where `end`
 * is the offset the next page starts at (listing.length on the last page).
 * The cut falls on a line end so no ¶ line is split; a single line longer
 * than the budget is cut where it must be.
 */
export function pageOfListing(listing, from, budget) {
  if (from + budget >= listing.length) return { text: listing.slice(from), end: listing.length };
  const nl = listing.lastIndexOf("\n", from + budget);
  const end = nl > from ? nl : from + budget;
  return { text: listing.slice(from, end), end: nl > from ? end + 1 : end };
}

const n = (v) => Number(v).toLocaleString("en");

export default ({ supabase, hubUrl, now }) => {
  const loader = createStandardLoader({ supabase, now });

  return [
    {
      name: "open_standard_for_filling",
      title: "Open a firm standard for filling",
      description: `The firm's Word standard for a document type, opened for a fill: every paragraph with a blank in it ([●], [•], [____], a [bracketed] value), numbered ¶n with its exact text, every heading and the paragraphs around each blank; the rest of the standard as gaps naming the ¶ numbers they hide, any of which paragraphs: "from-to" reads (at most ${MAX_RANGE} at a time) so a change inside a gap can quote the paragraph exactly. With the Hub's fill instructions, the operations protocol, and a templateHash that fill_standard_to_project must echo (a standard replaced in between is refused). The standard itself is never changed. Call list_document_types for the id; read_standard reads the whole text, get_drafting_decisions the type's questions. Long standards come in pages: start at from: 0 (the instructions are on that page) and continue where the reply says.`,
      inputSchema: {
        documentTypeId: z.string().describe("The document type's id, from list_document_types."),
        from: z.number().int().min(0).optional().describe("Character offset into the listing to continue from, as the previous page gave it. Default 0, the first page, which carries the instructions."),
        paragraphs: z.string().optional().describe(`Instead of a page of the listing: a range of paragraphs to read in full, "100-140", at most ${MAX_RANGE} at a time — for the paragraphs a "… not shown …" line names.`),
      },
      async run(input) {
        const id = uuid(input.documentTypeId);
        if (!id) throw new Error("documentTypeId must be a document type id (a UUID). list_document_types gives them.");
        const s = await loader.load(id);
        if (!s.template) return `${s.type.name} has no standard yet, so there is nothing to fill: draft it from the firm's rules (get_firm_rules) and precedents (search_precedents) instead. list_document_types shows which types have a Word standard.\n${openStandard(s.type.id, hubUrl)}`;
        if (!s.bytes) return `${s.type.name}'s standard is text only (no Word file), so there is nothing to fill: read_standard gives its text to draft from. list_document_types shows which types have a Word standard.\n${openStandard(s.type.id, hubUrl)}`;
        const { type, template, snapshot, hash, inspection, listing, shown, blanks } = s;
        const total = inspection.paragraphCount;
        const fileName = template.filename ?? template.storage_path;

        // A range read: the paragraphs themselves, from the full view.
        if (input.paragraphs != null && String(input.paragraphs).trim() !== "") {
          const range = parseRange(input.paragraphs);
          if (!range) throw new Error(`paragraphs must be a range of paragraph numbers such as "100-140" (at most ${MAX_RANGE} at a time).`);
          if (range.from > total) return `${type.name}'s standard (${fileName}) has ${n(total)} paragraphs (¶1–¶${n(total)}); there is no ¶${n(range.from)}. templateHash: ${hash}`;
          const head = [
            `${type.name}: the firm's Word standard ${fileName} — paragraphs ¶${n(range.from)}–¶${n(range.to)} of ${n(total)}, every one in that range as the standard reads (an empty paragraph has no number).${range.cut ? ` The range was cut to ${MAX_RANGE} paragraphs; ask for the rest next.` : ""}`,
            `templateHash: ${hash}`,
            openStandard(type.id, hubUrl),
            "The fill instructions and the operations protocol are on the listing's first page (from: 0).",
          ].join("\n");
          const page = rangeListing(inspection, range, Math.max(2_000, MAX_RESULT_CHARS - head.length - PAGE_MARGIN));
          if (!page.count) return `${head}\n\nThere is no paragraph with text between ¶${n(range.from)} and ¶${n(range.to)}.`;
          const next = page.more ? page.last + 1 : range.cut ? range.to + 1 : null;
          const tail = next
            ? `[${page.more ? `Stopped at ¶${n(page.last)} to stay under the size limit` : `The range continues`}: call open_standard_for_filling again with paragraphs: "${next}-${Math.min(next + MAX_RANGE - 1, total)}".]`
            : page.last >= total ? "[The standard ends here.]" : `[End of the range; the standard goes on to ¶${n(total)}.]`;
          return `${head}\n\nPARAGRAPHS ¶${n(range.from)}–¶${n(page.last)}:\n${page.text}\n\n${tail}`;
        }

        const from = Number.isInteger(input.from) && input.from > 0 ? input.from : 0;
        if (from >= listing.length) return `The listing of ${type.name}'s standard (${fileName}) is ${n(listing.length)} characters long; there is nothing at ${n(from)}. templateHash: ${hash}`;

        const coverage = shown >= total
          ? `all ${n(total)} paragraphs are listed`
          : `${n(shown)} of the ${n(total)} paragraphs are listed (the blanks, every heading and the paragraphs around each blank); the rest are gaps marked "not shown" with their ¶ numbers, which paragraphs: "from-to" reads`;
        const head = [
          `${type.name}: the firm's Word standard ${fileName}, as stored ${when(template.updated_at)} — ${n(total)} paragraphs, ${n(blanks.body)} of them with a blank to fill, every one listed with its ¶ number${blanks.notes ? `; ${n(blanks.notes)} more bracketed paragraphs are the firm's drafting notes in the footnotes (listed under their PART line for context, not slots to fill: the lawyer removes them in Word before circulation)` : ""}. ${coverage[0].toUpperCase()}${coverage.slice(1)}.`,
          `templateHash: ${hash}`,
          snapshot ? `Standard snapshot: ${snapshot.id} (filed ${when(snapshot.created_at)}); the Hub keeps this filing of the standard whole even if it is later replaced.` : "Standard snapshot: none recorded for this file.",
          openStandard(type.id, hubUrl),
        ];
        if (from === 0) {
          if (type.questionnaire) head.push(`This type has a drafting questionnaire: before any fill, call get_drafting_decisions and ask the lawyer each decision in prose, one at a time; the fill instructions' "do not stop to ask" applies to the fill call once the decisions are answered.`);
          const rules = str(template.format_rules, MAX_RULES_CHARS);
          head.push("", `FILL INSTRUCTIONS (the Hub's own, for a draft from this standard):\n${FILL_INSTRUCTIONS}${rules ? `\n\nHow the standard is formatted: ${rules}` : ""}`, "", OPS_PROTOCOL, "", FILL_DIRECT_NOTE, "", CONNECTOR_FILL_NOTE);
        } else {
          head.push("The fill instructions and the operations protocol are on the first page (from: 0).");
        }
        const headText = head.join("\n");
        const budget = Math.max(2_000, MAX_RESULT_CHARS - headText.length - PAGE_MARGIN);
        const page = pageOfListing(listing, from, budget);
        const tail = page.end < listing.length
          ? `[The listing continues: call open_standard_for_filling again with from: ${page.end}.]`
          : "[End of the listing.]";
        return `${headText}\n\nPARAGRAPHS (characters ${n(from + 1)}–${n(from + page.text.length)} of ${n(listing.length)}):\n${page.text}\n\n${tail}`;
      },
    },
  ];
};
