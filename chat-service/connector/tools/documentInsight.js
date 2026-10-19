// get_document_checks and compare_document_versions: the whole of what the
// Hub knows about a version's slips, and what changed between any two
// versions of a document. get_document_summary shows the first 15 findings
// and the comparison with the version just before; these give every
// finding and any pair, paged.
//
// The index worker stores both when it reads a version (proof_check and
// changes_from_previous on document_versions). When the stored one is there
// and is about the pair asked for, it is printed, and so is a stored
// refusal (a scan the worker gave up on, a file it cannot read: { skipped }
// or { error }), as get_document_summary prints it; otherwise, or when the
// caller asks with recheck: true, the files are read now with
// documentInsight.js (the same code as the site's preview routes), under
// the same two-minute deadline. An on-demand read of a scanned PDF is OCR
// on the one-vCPU box, so one runs at a time per process (a second caller
// is told to try again in a moment, as the clause search does) and its
// result is kept a while (RESULT_CACHE_MS), so the later pages of a long
// list come from memory rather than another read. Nothing here writes.

import { z } from "zod";
import { uuid, when, short } from "../tools.js";
import { ON_DEMAND_READ_MS, TOO_LONG_MESSAGE, deadlineStop, proofCheckVersion, compareVersionPair } from "../../documentInsight.js";

// A page of findings or changes stops here, well under the wrapper's cap,
// so the "continue at" line is never the part that gets cut.
export const PAGE_CHARS = 24_000;
const ITEM_CHARS = 400;
const SIDE_CHARS = 600;
// On-demand results kept for the next page: a few, for a while.
const RESULT_CACHE_MAX = 12;
export const RESULT_CACHE_MS = 20 * 60 * 1000;
export const BUSY = "Another document is being read on the Hub's connector; one on-demand read runs at a time, and each can take up to two minutes. Try again in a moment.";

export const CATEGORY_NAMES = { placeholders: "blanks and placeholders", undefined_terms: "terms used but not defined", unused_definitions: "definitions never used", broken_references: "cross-references to nothing", number_words: "numbers whose words and figures disagree", numbering: "gaps in numbering" };

const VERSION_COLUMNS = "id, version_number, file_name, storage_path, is_ai_generated, created_at, indexing_status";

// One on-demand read at a time in this process: the guard is shared by the
// two tools, since both read files the same way.
let reading = false;

/** A stored proof check the worker finished (not { error } or { skipped }). */
export const storedCheck = (v) => (v?.proof_check && typeof v.proof_check === "object" && Array.isArray(v.proof_check.items) ? v.proof_check : null);

/** Whether the comparison stored on `to` was made against `fromId`. */
const pairMatches = (to, fromId) => to?.compared_with_version_id === fromId || to?.changes_from_previous?.previous?.version_id === fromId;

/** The stored comparison of `to`, if it was made against `fromId`. */
export function storedChanges(to, fromId) {
  const ch = to?.changes_from_previous;
  if (!ch || typeof ch !== "object" || !Array.isArray(ch.items)) return null;
  return pairMatches(to, fromId) ? ch : null;
}

/**
 * The sentence for a stored result the worker did not finish ({ skipped }
 * or { error }), in get_document_summary's words, or null when it finished
 * or stored nothing. `verb` is "checked" or "compared".
 */
export function notDone(stored, verb) {
  if (!stored || typeof stored !== "object") return null;
  if (stored.error) return `Could not be ${verb}: ${stored.error}`;
  if (stored.skipped) return `Not ${verb}: ${stored.skipped}`;
  return null;
}

/**
 * Items from `from` on, printed one by one until the page is full:
 * { lines, end } where `end` is the index to continue at (items.length when
 * these were the last).
 */
export function pageOf(items, from, printOne) {
  const lines = [];
  let size = 0;
  let i = from;
  for (; i < items.length; i++) {
    const text = printOne(items[i], i + 1);
    if (lines.length && size + text.length > PAGE_CHARS) break;
    lines.push(text);
    size += text.length + 1;
  }
  return { lines, end: i };
}

const plural = (n, word) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

export default ({ supabase, log, now, helpers }) => {
  const { needVersion, versionById, versionName, open } = helpers;
  const results = new Map();

  /** The on-demand result kept under `key` (a version id, or from:to), or undefined. */
  function cached(key) {
    const hit = results.get(key);
    if (!hit || now() - hit.at >= RESULT_CACHE_MS) { results.delete(key); return undefined; }
    results.delete(key);
    results.set(key, hit);
    return hit.value;
  }

  // The on-demand read, with the route's deadline and its sentences, one at
  // a time, its result kept under `key` for the next page.
  async function onDemand(key, work) {
    const kept = cached(key);
    if (kept) return kept;
    if (reading) throw new Error(BUSY);
    reading = true;
    const options = { checkStop: deadlineStop({ ms: ON_DEMAND_READ_MS, now }), log };
    try {
      const value = await work(options);
      results.set(key, { at: now(), value });
      while (results.size > RESULT_CACHE_MAX) results.delete(results.keys().next().value);
      return value;
    } catch (err) {
      if (err?.tooLong) throw new Error(TOO_LONG_MESSAGE);
      if (err?.status || err?.permanent) throw new Error(err.message);
      log(`on-demand read failed: ${err?.message ?? err}`);
      throw new Error("The file could not be read.");
    } finally {
      reading = false;
    }
  }

  const startAt = (input) => (Number.isInteger(input.from) && input.from > 0 ? input.from : 0);
  const recheck = (input) => input.recheck === true;
  const RECHECK_DESCRIPTION = "Read the file now even when the Hub stored a result (or stored that it could not read the file). Default false.";

  const continueLine = (tool, end, total, what) => (end < total ? `[The list continues: call ${tool} again with from: ${end}.]` : `[End of the ${what}.]`);

  return [
    {
      name: "get_document_checks",
      title: "Every finding of a document's proof check",
      description: "The full proof check of one version of a project document: every blank and placeholder, term used but not defined, definition never used, cross-reference to a clause or schedule that does not exist, number whose words and figures disagree, and gap in clause numbering, each with the clause it sits in. Use it when get_document_summary's first 15 findings are not enough, e.g. to list every problem in a draft before it goes out. Returns the counts by category, then the findings numbered from 1, in pages: start at from: 0 and the reply says where to continue. Uses the check the Hub stored when it read the file; when there is none, the file is read now, which can take up to two minutes (one such read at a time). When the Hub stored that it could not check the file, that is reported; recheck: true reads the file anyway.",
      inputSchema: {
        versionId: z.string().describe("The document version's id, from list_project_documents."),
        from: z.number().int().min(0).optional().describe("The index of the first finding to show, from the previous reply. Default 0."),
        recheck: z.boolean().optional().describe(RECHECK_DESCRIPTION),
      },
      async run(input) {
        const v = await needVersion(input, `${VERSION_COLUMNS}, proof_check`);
        const stored = recheck(input) ? null : storedCheck(v);
        const head = `Proof check of ${versionName(v)}, project ${v.matter_document.matter.name}${v.is_ai_generated ? " (an AI draft)" : ""}`;
        const undone = recheck(input) ? null : notDone(v.proof_check, "checked");
        if (undone) return `${head}: ${undone}\n${open("version", v.id)}\nrecheck: true reads the file now (up to two minutes).`;
        const pc = stored ?? await onDemand(v.id, (options) => proofCheckVersion(supabase, v.id, options));
        const source = stored ? "the check the Hub stored when it read the file" : recheck(input) ? "checked now from the file, as asked" : "checked now from the file; the Hub had not stored a check for this version";
        const out = [`${head}: ${source}.`, open("version", v.id), ""];
        const counts = pc.counts ?? {};
        const items = Array.isArray(pc.items) ? pc.items : [];
        out.push(`${plural(pc.total ?? items.length, "finding")}${pc.checked_at ? ` (checked ${when(pc.checked_at)})` : ""}: ${Object.keys(CATEGORY_NAMES).map((k) => `${CATEGORY_NAMES[k]} ${counts[k] ?? 0}`).join("; ")}.`);
        for (const n of pc.notes ?? []) out.push(n);
        const omitted = Object.entries(pc.omitted ?? {}).filter(([, n]) => n > 0);
        if (omitted.length) out.push(`Not listed (the Hub keeps at most 100 findings in a category): ${omitted.map(([k, n]) => `${n} more under ${CATEGORY_NAMES[k] ?? k}`).join("; ")}.`);
        if (!items.length) return out.join("\n");
        const from = startAt(input);
        if (from >= items.length) return `${out[0]}\nThere are ${plural(items.length, "finding")}; there is nothing at from: ${from}.`;
        const page = pageOf(items, from, (it, n) => `  ${n}. [${it.category ?? "finding"}${it.severity ? `, ${it.severity}` : ""}] ${it.where ? `${it.where}: ` : ""}${short(it.text, ITEM_CHARS)}${it.note ? ` — ${short(it.note, ITEM_CHARS)}` : ""}`);
        out.push("", `Findings ${from + 1}–${page.end} of ${items.length}:`, ...page.lines, "", continueLine("get_document_checks", page.end, items.length, "findings"));
        return out.join("\n");
      },
    },
    {
      name: "compare_document_versions",
      title: "What changed between two versions",
      description: "A clause-by-clause comparison of any two versions of the same project document: each change with the clause it is in, what it is (changed, added, removed, moved), its nature (wording; numbers, dates or names; definitions; a clause added or removed; a schedule; renumbering) and the text before and after. Use it to tell a lawyer what the other side changed between v1 and v3, or what an AI draft altered. Formatting-only changes are counted but not listed unless includeFormatting is true. Returns the counts, then the changes numbered from 1, in pages: start at from: 0 and the reply says where to continue. Uses the comparison the Hub stored when it read the later version if it was made against the earlier one; otherwise both files are read now, which can take up to two minutes (one such read at a time). When the Hub stored that it could not compare that pair, that is reported; recheck: true reads the files anyway.",
      inputSchema: {
        fromVersionId: z.string().describe("The earlier version's id, from list_project_documents."),
        toVersionId: z.string().describe("The later version's id, from list_project_documents."),
        from: z.number().int().min(0).optional().describe("The index of the first change to show, from the previous reply. Default 0."),
        includeFormatting: z.boolean().optional().describe("Also list formatting-only changes. Default false."),
        recheck: z.boolean().optional().describe(RECHECK_DESCRIPTION),
      },
      async run(input) {
        const fromId = uuid(input.fromVersionId);
        const toId = uuid(input.toVersionId);
        if (!fromId || !toId) throw new Error("fromVersionId and toVersionId must be document version ids (UUIDs). list_project_documents gives them.");
        if (fromId === toId) throw new Error("Pick two different versions to compare.");
        const columns = `${VERSION_COLUMNS}, changes_from_previous, compared_with_version_id`;
        const [from, to] = await Promise.all([versionById(fromId, columns), versionById(toId, columns)]);
        if (!from || !to) throw new Error(`There is no project document version with the ${!from ? "fromVersionId" : "toVersionId"} given. list_project_documents gives them.`);
        if (from.matter_document.id !== to.matter_document.id) throw new Error("Both versions must belong to the same document.");
        const stored = recheck(input) ? null : storedChanges(to, from.id);
        const head = `Changes from ${versionName(from)} to ${versionName(to)}, project ${to.matter_document.matter.name}`;
        const links = [`${open("version", to.id)} (v${to.version_number})`, `${open("version", from.id)} (v${from.version_number})`];
        const undone = recheck(input) || !pairMatches(to, from.id) ? null : notDone(to.changes_from_previous, "compared");
        if (undone) return [`${head}: ${undone}`, ...links, "recheck: true reads the two files now (up to two minutes)."].join("\n");
        const ch = stored ?? await onDemand(`${from.id}:${to.id}`, (options) => compareVersionPair(supabase, from.id, to.id, options));
        const source = stored ? "the comparison the Hub stored when it read the later version" : recheck(input) ? "compared now from the two files, as asked" : "compared now from the two files";
        const out = [`${head}: ${source}.`, ...links, ""];
        if (ch.unrelated) { out.push(`The two files do not look like versions of the same document (similarity ${ch.similarity ?? "?"}), so there is no clause-by-clause comparison to read.`); return out.join("\n"); }
        if (ch.identical) { out.push(`No change in the text between the two versions${ch.compared_at ? ` (compared ${when(ch.compared_at)})` : ""}.`); return out.join("\n"); }
        const c = ch.counts ?? {};
        out.push(`${c.changed ?? 0} changed, ${c.added ?? 0} added, ${c.removed ?? 0} removed, ${c.moved ?? 0} moved${ch.compared_at ? ` (compared ${when(ch.compared_at)})` : ""}; ${ch.shown ?? 0} shown, ${ch.hidden ?? 0} formatting-only ${input.includeFormatting ? "listed too" : "hidden (includeFormatting: true lists them)"}.`);
        const natures = Object.entries(ch.natures ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`);
        if (natures.length) out.push(`By nature: ${natures.join("; ")}.`);
        for (const n of ch.notes ?? []) out.push(n);
        if (ch.omitted > 0) out.push(`Not listed: ${ch.omitted} more changes beyond the ${ch.items.length} the Hub keeps.`);
        const items = (Array.isArray(ch.items) ? ch.items : []).filter((it) => input.includeFormatting || it.nature !== "formatting_only");
        if (!items.length) return out.join("\n");
        const start = startAt(input);
        if (start >= items.length) return `${out[0]}\nThere are ${plural(items.length, "change")}; there is nothing at from: ${start}.`;
        const page = pageOf(items, start, (it, n) => {
          const before = short(it.before, SIDE_CHARS);
          const after = short(it.after, SIDE_CHARS);
          return `  ${n}. ${it.where ? `${it.where}: ` : ""}${it.kind}${it.nature ? ` (${String(it.nature).replace(/_/g, " ")})` : ""}${it.noise ? ` [${it.noise}]` : ""}${before ? `\n     before: ${before}` : ""}${after ? `\n     after:  ${after}` : ""}`;
        });
        out.push("", `Changes ${start + 1}–${page.end} of ${items.length}:`, ...page.lines, "", continueLine("compare_document_versions", page.end, items.length, "changes"));
        return out.join("\n");
      },
    },
  ];
};
