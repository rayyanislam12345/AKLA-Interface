// check_text and compare_text_with_version: the Hub's proof check on text
// claude.ai has written, and a clause-by-clause comparison of that text
// against a stored version, so the associate sees the blanks and the
// changes before anything is filed. Neither calls a model and neither
// writes.
//
// The text is read the way the index worker reads a saved Markdown file
// (readForCompare on the bytes as draft.md: paragraphs, clause labels, "#"
// headings), so what check_text finds is what the Hub will store for the
// version once the text is saved as .md, and the comparison sees the same
// clauses the worker will. The version's file is read the way
// documentInsight.js reads one (its extension rule, the matter-documents
// bucket, the two-minute deadline), and both results are printed and paged
// exactly as get_document_checks and compare_document_versions print
// theirs.
//
// The connector keeps nothing of the text between calls: a later page is
// asked for with `from` and the same text again. The version's reading is
// kept a while (RESULT_CACHE_MS) so the later pages of a long comparison,
// or a second redraft against the same version, do not read the file
// again. A scan is OCR on the one-vCPU box, so one file read runs at a
// time here (documentInsight.js guards its own reads the same way; the two
// guards are separate, so at most two reads can overlap on the box).

import { z } from "zod";
import { READ_ONLY } from "../app.js";
import { short, uuid } from "../tools.js";
import { runProofCheck, runWordingCheck, wordingSummary } from "../../proofCheck.js";
import { FAMILY_KEYS, styleSheetKeyFor } from "../../styleSheets/index.js";
import { COMPARABLE_EXTENSIONS, compareVersions, readForCompare } from "../../versionCompare.js";
import { ON_DEMAND_READ_MS, TOO_LONG_MESSAGE, deadlineStop } from "../../documentInsight.js";
import { BUSY, CATEGORY_NAMES, RESULT_CACHE_MS, pageOf } from "./documentInsight.js";

/** The most text one call reads (the plan's cap). */
export const MAX_TEXT_CHARS = 300_000;
/**
 * The longest run without a space the check will read. The proof check's
 * time grows with the square of a single token's length (40,000 characters
 * in one token takes two seconds, 300,000 two minutes, while 300,000
 * characters of words take a few milliseconds), and the connector is one
 * process for every lawyer, so a pasted blob is refused rather than run.
 */
export const MAX_WORD_CHARS = 5_000;
const ITEM_CHARS = 400;
const SIDE_CHARS = 600;
// Version readings kept for the next page or the next redraft: a few, for a while.
const READING_CACHE_MAX = 12;
/** The name the text is read under: the worker's Markdown reader. */
export const TEXT_FILE_NAME = "draft.md";

export const EMPTY_TEXT = "text must be the draft to check: plain text or Markdown, not empty.";
export const TOO_LONG_TEXT = `The text is longer than ${MAX_TEXT_CHARS.toLocaleString("en")} characters, which is more than this tool reads in one call; check it in parts.`;
export const NO_WORDS = "The text has no words to check.";
export const LONG_WORD = `The text has an unbroken run of more than ${MAX_WORD_CHARS.toLocaleString("en")} characters with no space in it (a pasted blob, not words), which the check cannot read; leave it out and try again.`;
const LONG_WORD_RE = new RegExp(`\\S{${MAX_WORD_CHARS + 1},}`);

const VERSION_COLUMNS = "id, version_number, file_name, storage_path, is_ai_generated";

/** The wording check's categories as the reply names them. */
export const WORDING_NAMES = { defined_term_form: "defined-term form", number_words: "numbers and money in words and figures", date_format: "dates", placeholder_style: "placeholder style", cross_ref_heading: "cross-references and their headings", spelling_convention: "spelling", banned_phrase: "phrasing the firm does not use", government_named: "a government or province named" };

// One file read at a time in this module (see the header).
let reading = false;

const plural = (n, word) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;
const chars = (text) => `${text.length.toLocaleString("en")} characters`;

/**
 * The text as the index worker reads a saved Markdown file: the shape
 * readForCompare returns ({ blocks, side, … }), for runProofCheck and
 * compareVersions. Refuses with one sentence when there is no text, too
 * much of it, a run too long to check, or nothing in it to read.
 */
export async function readText(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error(EMPTY_TEXT);
  if (text.length > MAX_TEXT_CHARS) throw new Error(TOO_LONG_TEXT);
  if (LONG_WORD_RE.test(text)) throw new Error(LONG_WORD);
  let read;
  try {
    read = await readForCompare(new TextEncoder().encode(text), TEXT_FILE_NAME);
  } catch {
    throw new Error(NO_WORDS);
  }
  if (!Array.isArray(read?.blocks) || !read.blocks.length) throw new Error(NO_WORDS);
  return read;
}

export default ({ supabase, log, now, helpers }) => {
  const { needVersion, versionName, open } = helpers;
  const readings = new Map();

  /** The reading of the version kept under its id, or undefined. */
  function cachedReading(id) {
    const hit = readings.get(id);
    if (!hit || now() - hit.at >= RESULT_CACHE_MS) { readings.delete(id); return undefined; }
    readings.delete(id);
    readings.set(id, hit);
    return hit.value;
  }

  // The version's file, read as documentInsight.js reads one: the
  // extension rule first (no download for a spreadsheet), then the bucket,
  // then the worker's reader under the route's deadline, one at a time.
  async function readVersion(v) {
    const kept = cachedReading(v.id);
    if (kept) return kept;
    const ext = (/\.([A-Za-z0-9]+)$/.exec(v.storage_path ?? "")?.[1] ?? "").toLowerCase();
    if (!COMPARABLE_EXTENSIONS.includes(ext)) throw new Error(`v${v.version_number} is not a Word, PDF or text file, so it cannot be compared.`);
    if (reading) throw new Error(BUSY);
    reading = true;
    try {
      const checkStop = deadlineStop({ ms: ON_DEMAND_READ_MS, now });
      const { data: file, error } = await supabase.storage.from("matter-documents").download(v.storage_path);
      if (error || !file) throw Object.assign(new Error(`The file for v${v.version_number} is missing from storage.`), { plain: true });
      checkStop();
      const value = await readForCompare(new Uint8Array(await file.arrayBuffer()), `file.${ext}`, { checkStop });
      readings.set(v.id, { at: now(), value });
      while (readings.size > READING_CACHE_MAX) readings.delete(readings.keys().next().value);
      return value;
    } catch (err) {
      if (err?.tooLong) throw new Error(TOO_LONG_MESSAGE);
      if (err?.plain || err?.permanent || err?.unsupported) throw new Error(err.message);
      log(`compare_text_with_version: reading v${v.version_number} (${v.id}) failed: ${err?.message ?? err}`);
      throw new Error("The file could not be read.");
    } finally {
      reading = false;
    }
  }

  const startAt = (input) => (Number.isInteger(input.from) && input.from > 0 ? input.from : 0);
  const continueLine = (tool, again, end, total, what) => (end < total ? `[The list continues: call ${tool} again with ${again} and from: ${end}.]` : `[End of the ${what}.]`);

  return [
    {
      name: "check_text",
      title: "Proof-check a draft before it is saved",
      description: "The Hub's proof check, run on text you have written or are about to file (plain text or Markdown): every blank and placeholder ([●], [insert …], TBD), term used but not defined, definition never used, cross-reference to a clause or schedule that does not exist, number whose words and figures disagree, and gap in clause numbering, each with the clause it sits in. No model is involved, nothing is saved and nothing in the Hub changes. Use it on a draft or a redraft before filing it with save_note_to_project or save_draft_to_project, and fix what it finds first; it is the same check the Hub stores for a saved version (get_document_checks), so a draft that is clean here is clean there. With documentTypeId (or a styleSheet by name) it also checks the wording against the firm's style sheet for that kind of document — defined terms bold in brackets without quotation marks, numbers and money in words and figures, dates, [●], cross-references with their headings, British spelling, phrasing the firm does not use — and lists those findings after the proof check's; they never stop a filing. Returns the counts by category, then the findings numbered from 1, in pages: start at from: 0 and send the same text (and the same documentTypeId) again with the from the reply gives. Text up to 300,000 characters a call.",
      inputSchema: {
        // No .max here: the SDK would refuse the call with a validation dump before run(); readText refuses over-long text with the plain sentence instead.
        text: z.string().describe(`The draft to check: plain text or Markdown, exactly as it would be saved. Up to ${MAX_TEXT_CHARS.toLocaleString("en")} characters.`),
        from: z.number().int().min(0).optional().describe("The index of the first finding to show, from the previous reply. Default 0."),
        documentTypeId: z.string().optional().describe("Optional: the document type's id (list_document_types), to check the wording against the firm's style sheet for that kind of document as well."),
        styleSheet: z.string().optional().describe(`Optional, instead of documentTypeId: a style sheet by name (${FAMILY_KEYS.join(", ")}, or "core" for the firm-wide rules alone).`),
      },
      annotations: READ_ONLY,
      async run(input) {
        // The style sheet, when one is asked for: by the type's name, or by its own name.
        let sheet = null;
        if (input.documentTypeId != null && String(input.documentTypeId).trim() !== "") {
          const id = uuid(input.documentTypeId);
          if (!id) throw new Error("documentTypeId must be a document type id (a UUID). list_document_types gives them.");
          const { data, error } = await supabase.from("document_types").select("id, name").eq("id", id).maybeSingle();
          if (error) throw new Error(`Could not read the document type: ${error.message}`);
          if (!data) throw new Error("There is no document type with that id. list_document_types gives them.");
          sheet = { key: styleSheetKeyFor(data.name) ?? "core", typeName: data.name };
        } else if (typeof input.styleSheet === "string" && input.styleSheet.trim()) {
          const name = input.styleSheet.trim();
          const key = name.toLowerCase() === "core" ? "core" : styleSheetKeyFor(name);
          if (!key) throw new Error(`There is no style sheet called "${name}": the firm's are ${FAMILY_KEYS.join(", ")}, and "core" for the firm-wide rules.`);
          sheet = { key, typeName: null };
        }
        const read = await readText(input.text);
        const pc = runProofCheck(read);
        const out = [`Proof check of the text given (${chars(input.text)}, ${plural(pc.paragraphs ?? 0, "paragraph")}): checked now, without a model; nothing was saved.`];
        const counts = pc.counts ?? {};
        let items = Array.isArray(pc.items) ? pc.items : [];
        out.push(`${plural(pc.total ?? items.length, "finding")}: ${Object.keys(CATEGORY_NAMES).map((k) => `${CATEGORY_NAMES[k]} ${counts[k] ?? 0}`).join("; ")}.`);
        for (const n of pc.notes ?? []) out.push(n);
        const omitted = Object.entries(pc.omitted ?? {}).filter(([, n]) => n > 0);
        if (omitted.length) out.push(`Not listed (the check keeps at most 100 findings in a category): ${omitted.map(([k, n]) => `${n} more under ${CATEGORY_NAMES[k] ?? k}`).join("; ")}.`);
        // The wording check against the firm's style sheet, beside the proof
        // check: its findings follow the proof check's in the same list.
        if (sheet) {
          const wc = runWordingCheck(read, { styleSheet: sheet.key });
          out.push(`${wordingSummary(wc)} (Style sheet: ${wc.style_sheet === "core" ? "the firm-wide rules" : `"${wc.style_sheet}" on top of the firm-wide rules`}${sheet.typeName ? `, for ${sheet.typeName}` : ""}.)`);
          for (const n of wc.notes ?? []) out.push(n);
          items = [...items, ...(wc.items ?? []).map((it) => ({ ...it, category: `wording: ${WORDING_NAMES[it.category] ?? it.category}` }))];
        }
        if (!items.length) return out.join("\n");
        const from = startAt(input);
        if (from >= items.length) return `${out[0]}\nThere are ${plural(items.length, "finding")}; there is nothing at from: ${from}.`;
        const page = pageOf(items, from, (it, n) => `  ${n}. [${it.category ?? "finding"}${it.severity ? `, ${it.severity}` : ""}] ${it.where ? `${it.where}: ` : ""}${short(it.text, ITEM_CHARS)}${it.note ? ` — ${short(it.note, ITEM_CHARS)}` : ""}`);
        out.push("", `Findings ${from + 1}–${page.end} of ${items.length}:`, ...page.lines, "", continueLine("check_text", "the same text", page.end, items.length, "findings"));
        return out.join("\n");
      },
    },
    {
      name: "compare_text_with_version",
      title: "What a redraft changes against a stored version",
      description: "A clause-by-clause comparison of text you have written (a redraft, plain text or Markdown) against one stored version of a project document: each change with the clause it is in, what it is (changed, added, removed, moved), its nature (wording; numbers, dates or names; definitions; a clause added or removed; a schedule; renumbering) and the text before (the stored version) and after (your text). No model is involved, nothing is saved and nothing in the Hub changes. Use it to show a lawyer exactly what a redraft alters before it is filed as the next version, or to confirm that a redraft changed only what was asked; to compare two stored versions use compare_document_versions instead. Formatting-only changes are counted but not listed unless includeFormatting is true. Returns the counts, then the changes numbered from 1, in pages: start at from: 0 and send the same versionId and text again with the from the reply gives. The version's file is read now unless it was read a moment ago, which can take up to two minutes for a scan (one such read at a time). Text up to 300,000 characters a call.",
      inputSchema: {
        versionId: z.string().describe("The stored version's id, from list_project_documents: the text is compared against it."),
        text: z.string().describe(`Your text: the redraft, plain text or Markdown, exactly as it would be saved. Up to ${MAX_TEXT_CHARS.toLocaleString("en")} characters.`),
        from: z.number().int().min(0).optional().describe("The index of the first change to show, from the previous reply. Default 0."),
        includeFormatting: z.boolean().optional().describe("Also list formatting-only changes. Default false."),
      },
      annotations: READ_ONLY,
      async run(input) {
        const v = await needVersion(input, VERSION_COLUMNS);
        const mine = await readText(input.text);
        const theirs = await readVersion(v);
        const ch = compareVersions(theirs, mine);
        const head = `Changes from ${versionName(v)}, project ${v.matter_document.matter.name}${v.is_ai_generated ? " (an AI draft)" : ""}, to the text given (${chars(input.text)}): compared now, without a model; nothing was saved.`;
        const out = [head, `${open("version", v.id)} (v${v.version_number})`, ""];
        if (ch.unrelated) { out.push(`The text given does not look like a version of ${versionName(v)} (similarity ${ch.similarity ?? "?"}), so there is no clause-by-clause comparison to read.`); return out.join("\n"); }
        if (ch.identical) { out.push(`No change in the text: the text given reads the same as ${versionName(v)}.`); return out.join("\n"); }
        const c = ch.counts ?? {};
        out.push(`${c.changed ?? 0} changed, ${c.added ?? 0} added, ${c.removed ?? 0} removed, ${c.moved ?? 0} moved; ${ch.shown ?? 0} shown, ${ch.hidden ?? 0} formatting-only ${input.includeFormatting ? "listed too" : "hidden (includeFormatting: true lists them)"}.`);
        const natures = Object.entries(ch.natures ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`);
        if (natures.length) out.push(`By nature: ${natures.join("; ")}.`);
        for (const n of ch.notes ?? []) out.push(n);
        if (ch.omitted > 0) out.push(`Not listed: ${ch.omitted} more changes beyond the ${ch.items.length} the comparison keeps.`);
        const items = (Array.isArray(ch.items) ? ch.items : []).filter((it) => input.includeFormatting || it.nature !== "formatting_only");
        if (!items.length) return out.join("\n");
        const start = startAt(input);
        if (start >= items.length) return `${head}\nThere are ${plural(items.length, "change")}; there is nothing at from: ${start}.`;
        const page = pageOf(items, start, (it, n) => {
          const before = short(it.before, SIDE_CHARS);
          const after = short(it.after, SIDE_CHARS);
          return `  ${n}. ${it.where ? `${it.where}: ` : ""}${it.kind}${it.nature ? ` (${String(it.nature).replace(/_/g, " ")})` : ""}${it.noise ? ` [${it.noise}]` : ""}${before ? `\n     before: ${before}` : ""}${after ? `\n     after:  ${after}` : ""}`;
        });
        out.push("", `Changes ${start + 1}–${page.end} of ${items.length}:`, ...page.lines, "", continueLine("compare_text_with_version", "the same versionId and text", page.end, items.length, "changes"));
        return out.join("\n");
      },
    },
  ];
};
