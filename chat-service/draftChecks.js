// The firm's drafting rules on a Word turn (docs/drafting-fidelity-plan-
// 2026-10-19.md, slices 3 and 4 wired in): what a draft prompt is told, the
// comments a turn's own writing earns, and the clause-list check before a
// draft is filed. The Hub (server.js, a turn on a Word file) and the
// connector (connector/tools/fillStandard.js, fillStandardWrite.js,
// markup.js) both go through here, so a draft made in either place is held
// to the same rules.
//
// - The prompt: the style sheet for the kind of document (firmRules.js
//   styleSheetText), its clause list (skeletonCheck.js skeletonText), its
//   drafting decisions in a few lines, and the firm's own versions of the
//   clauses the turn is about to write (clauseBank.js; skipped silently
//   before the clause bank's migration or on any error: examples never fail
//   a turn).
// - Comments added to the turn's own operations, in the same pass: the
//   "New clause — not in the firm's precedents" comment a new heading was
//   written without (skeletonCheck.js uncommentedNewClauses), and one AKLA
//   comment per wording point (proofCheck.js runWordingCheck) in what the
//   turn WROTE — the text of its replace, insert_after, write and add_row
//   operations, never the pack's untouched words: a replaced paragraph's
//   points are the new text's less the points its old text already had.
//   At most MAX_WORDING_COMMENTS a turn; the rest are counted in the reply.
//   Wording points never stop a draft being filed.
// - The clause-list check on the file about to be stored (skeletonCheck.js
//   checkSkeleton): a part the firm always has that is missing stops the
//   draft being filed, exactly as the format gate does, until the lawyer
//   confirms the omission. On a draft from a shell pack (a letter, a memo:
//   the body is written fresh) every required part counts; on any other
//   draft or edit only a part the turn itself takes out does — a part the
//   firm's own form, or a counterparty's draft, never had is reported, not
//   refused.
//
// Nothing here writes to the database or the document.

import { styleSheetText, styleSheetFor, styleSheetKeyFor } from "./firmRules.js";
import { runWordingCheck, wordingSummary, WORDING_CATEGORIES } from "./proofCheck.js";
import { clauseExamples, clauseExamplesText, NEEDS_MIGRATION } from "./clauseBank.js";
import { checkSkeleton, skeletonFor, skeletonText, uncommentedNewClauses, itemsOf, normaliseHeading, NEW_CLAUSE_PREFIX } from "./skeletonCheck.js";
import { questionnaireFor } from "./questionnaire.js";

/** The most wording comments one turn adds; the rest are counted in the reply. */
export const MAX_WORDING_COMMENTS = 20;
/** The most clause headings one prompt is shown the firm's versions of. */
export const MAX_EXAMPLE_HEADINGS = 6;
/** The most characters of the firm's clauses one prompt carries. */
export const MAX_EXAMPLES_CHARS = 12_000;
/** The most characters the decisions take in a fill prompt. */
const MAX_DECISIONS_CHARS = 4_000;
/** The most clause-list points a reply lists before counting the rest. */
const MAX_POINTS = 8;

// ---------------------------------------------------------------- the type

/** The document_types columns the clause list and decisions live in (20261021100000). */
export const DRAFTING_COLUMNS = "skeleton, decisions";
const MISSING_COLUMN = /\b(skeleton|decisions)\b|does not exist|schema cache/i;

/**
 * Runs read(true) — a query that selects DRAFTING_COLUMNS — and, if the
 * database says a column is missing (before 20261021100000 is applied),
 * read(false). The clause list and decisions then come from the data files
 * by the type's name (skeletonFor, questionnaireFor).
 */
export async function withDraftingColumns(read) {
  const first = await read(true);
  if (first?.error && MISSING_COLUMN.test(String(first.error.message ?? ""))) return read(false);
  return first;
}

/** A document_types row with its clause list and decisions, or null. */
export async function draftingTypeOf(supabase, id) {
  if (!supabase || !id) return null;
  const { data, error } = await withDraftingColumns((withDrafting) => supabase
    .from("document_types")
    .select(`id, name, category, questionnaire${withDrafting ? `, ${DRAFTING_COLUMNS}` : ""}`)
    .eq("id", id)
    .maybeSingle());
  if (error) throw new Error(`Could not read the document type: ${error.message}`);
  return data ?? null;
}

/**
 * What the rules need of a kind of document: its name, its clause list
 * (or null), its style sheet (the core alone for a kind without one) and its
 * drafting decisions (or null).
 */
export function draftingOf(type) {
  const typeName = type?.name ?? null;
  return {
    typeId: type?.id ?? null,
    typeName,
    skeleton: type ? skeletonFor(type) : null,
    styleKey: styleSheetKeyFor(typeName),
    styleSheet: styleSheetFor(typeName),
    questionnaire: type ? questionnaireFor(type) : null,
  };
}

// ---------------------------------------------------------------- the prompt

/**
 * The decisions as a few lines for a fill prompt: each one's title, question
 * and options, and what to do with one the lawyer has not settled.
 */
export function decisionsPromptText(questionnaire) {
  const qs = questionnaire?.questions ?? [];
  if (!qs.length) return "";
  const lines = [`THE FIRM'S DRAFTING DECISIONS for this document (${qs.length}). Settle each from the lawyer's instructions and the project's documents. One that is not settled is never given a default (an arbitration forum least of all): keep the standard's bracketed alternatives, or leave the clause as the standard has it, and put one AKLA comment on it asking for the choice.`];
  let used = lines[0].length;
  for (const [n, q] of qs.entries()) {
    const line = `- ${q.title}: ${q.question} (${q.options.map((o) => o.label).join(" / ")})`;
    if (used + line.length > MAX_DECISIONS_CHARS) { lines.push(`- and ${qs.length - n} more.`); break; }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** The style sheet, the clause list and the decisions, as one block for a draft prompt. */
export function draftingPromptText({ typeName, skeleton = null, questionnaire = null, decisions = true } = {}) {
  return [styleSheetText(typeName), skeleton ? skeletonText(skeleton) : "", decisions ? decisionsPromptText(questionnaire) : ""].filter(Boolean).join("\n\n");
}

const plainWords = (s) => ` ${String(s ?? "").normalize("NFKC").toLowerCase().replace(/[‘’“”"'`]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()} `;
const itemNames = (it) => [it.heading, it.label, ...(it.synonyms ?? [])].map(normaliseHeading).filter((n) => n && !n.includes("\u0001")).map((n) => n.replace(/[^a-z0-9]+/g, " ").trim()).filter((n) => n.length >= 3);

/**
 * The clause headings a turn is about to write, for the firm's versions of
 * them: the clauses the lawyer's message names first, then the parts of the
 * clause list the document does not have yet, in the list's order. Only
 * headed clauses (a letter's fixed parts have no clause to show). At most
 * `max`.
 */
export function examplesHeadings({ skeleton, bytes = null, kinds = null, answers = null, message = "", max = MAX_EXAMPLE_HEADINGS } = {}) {
  const items = itemsOf(skeleton).filter((it) => (it.match ?? "heading") === "heading" && it.level >= 1);
  if (!items.length) return [];
  const said = plainWords(message);
  const named = items.filter((it) => itemNames(it).some((n) => said.includes(` ${n} `)));
  let missing = [];
  if (bytes) {
    try {
      const r = checkSkeleton({ bytes, skeleton, kinds, answers });
      const ids = new Set([...r.missing, ...r.decisionOpen].map((m) => m.id));
      missing = items.filter((it) => ids.has(it.id));
    } catch {
      missing = [];
    }
  }
  const out = [];
  for (const it of [...named, ...missing]) {
    const heading = it.examples_heading ?? it.heading;
    if (!out.includes(heading)) out.push(heading);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The firm's versions of each heading, as one prompt block of at most
 * maxChars: { text, headings, skipped }. Never throws: before the clause
 * bank's migration, or on any error, the block is empty and `skipped` says
 * why (for the log).
 */
export async function clauseExamplesBlock({ supabase, typeId, typeName = null, headings, maxChars = MAX_EXAMPLES_CHARS } = {}) {
  if (!supabase || !typeId || !headings?.length) return { text: "", headings: [], skipped: null };
  const k = headings.length <= 3 ? 3 : 2;
  const family = styleSheetKeyFor(typeName);
  let skipped = null;
  const found = await Promise.all(headings.map((heading) => clauseExamples({ supabase, typeId, heading, k, family }).then(
    (examples) => ({ heading, examples }),
    (err) => { skipped ??= err?.message === NEEDS_MIGRATION ? "the clause bank's migration is not applied" : String(err?.message ?? err); return { heading, examples: [] }; },
  )));
  if (skipped && found.every((f) => !f.examples.length)) return { text: "", headings: [], skipped };
  const parts = [];
  const used = [];
  let length = 0;
  for (const { heading, examples } of found) {
    const block = clauseExamplesText(examples, { heading });
    if (!block) continue;
    if (length + block.length + 2 > maxChars) {
      const room = maxChars - length - 2;
      if (room > 1_000) { parts.push(`${block.slice(0, room - 1).trimEnd()}…`); used.push(heading); }
      break;
    }
    parts.push(block);
    used.push(heading);
    length += block.length + 2;
  }
  return { text: parts.join("\n\n"), headings: used, skipped };
}

// ---------------------------------------------------------------- comments on what the turn wrote

// The words of an operation's text as the reader sees them: no "**" around
// a defined term, no "# " before a heading.
const words = (s) => String(s ?? "").replace(/\*\*/g, "").replace(/^\s*#{1,6}\s+/, "").trim();
const opName = (op) => String(op?.op ?? op?.kind ?? "").toLowerCase();
const CATEGORY_WORDS = { defined_term_form: "defined term", number_words: "number or amount", date_format: "date", placeholder_style: "placeholder", cross_ref_heading: "cross-reference", spelling_convention: "spelling", banned_phrase: "phrasing", government_named: "named government" };

/**
 * What one operation wrote, and where a comment on it can go: { anchor,
 * expected, fresh, newTexts, oldTexts } or null for an operation that
 * writes no words of its own (delete, remove_block, repeat_block — a copy
 * of the firm's own paragraphs — and comments). `fresh` is true when the
 * words are in paragraphs the turn adds, which cannot take a comment in the
 * same turn, so the comment goes on the paragraph they follow.
 */
export function writtenBy(op) {
  const kind = opName(op);
  const at = (v) => (Number.isInteger(Number(v)) && v !== null && v !== "" ? Number(v) : null);
  if (kind === "replace" && typeof op.text === "string") return { anchor: at(op.p), expected: op.expected, fresh: false, newTexts: [words(op.text)], oldTexts: [words(op.expected)] };
  if (kind === "insert_after" && typeof op.text === "string") return { anchor: at(op.p), expected: op.expected, fresh: true, newTexts: [words(op.text)], oldTexts: [] };
  if (kind === "write" && Array.isArray(op.blocks)) {
    const texts = op.blocks.flatMap((b) => (typeof b?.text === "string" ? [words(b.text)] : Array.isArray(b?.rows) ? b.rows.flatMap((r) => (Array.isArray(r) ? r.map(words) : [])) : []));
    return { anchor: at(op.after), expected: op.expected, fresh: true, newTexts: texts, oldTexts: [] };
  }
  if (kind === "add_row" && Array.isArray(op.cells)) return { anchor: at(op.like_row), expected: op.expected, fresh: true, newTexts: op.cells.map(words), oldTexts: [] };
  return null;
}

/** The ¶ numbers a turn's operations delete or remove: no comment can stand on them. */
function removedBy(ops) {
  const gone = new Set();
  for (const op of ops ?? []) {
    const kind = opName(op);
    if (kind === "delete" && Number.isInteger(Number(op.p))) gone.add(Number(op.p));
    if (kind === "remove_block" && Number.isInteger(Number(op.from)) && Number.isInteger(Number(op.to))) for (let n = Number(op.from); n <= Number(op.to); n++) gone.add(n);
  }
  return gone;
}

const pointKey = (it) => `${it.category}\u0000${it.note}`;

/**
 * The wording points in what a turn's operations wrote, as AKLA comment
 * operations on the paragraphs they target: { ops, result, shown, omitted,
 * checked, line }. `result` has the shape wordingSummary reads (counts and
 * total over every point found, shown or not); `line` is the reply's line,
 * empty when the turn wrote no words.
 * `more` is how the lawyer sees the rest ("ask to see them" in the Hub,
 * whose next turn is shown them; check_text in claude.ai). `rest` are the
 * points not commented on: { paragraph, note, find }.
 * @param {{ ops: Array<object>, styleSheet?: string|object|null, max?: number, more?: string }} input
 */
export function wordingCommentOps({ ops, styleSheet = null, max = MAX_WORDING_COMMENTS, more = "ask to see them" } = {}) {
  const gone = removedBy(ops);
  const points = [];
  let checked = 0;
  for (const op of ops ?? []) {
    const w = writtenBy(op);
    if (!w || w.anchor === null || typeof w.expected !== "string" || gone.has(w.anchor)) continue;
    const texts = w.newTexts.filter((t) => t.trim());
    if (!texts.length) continue;
    checked += texts.length;
    let found;
    try {
      found = runWordingCheck(texts.map((text) => ({ text })), { styleSheet }).items;
    } catch {
      continue; // a check that cannot read the text says nothing
    }
    if (!found.length) continue;
    // A replaced paragraph: what its old words already had is the pack's, not this turn's.
    const before = new Map();
    const old = w.oldTexts.filter((t) => t.trim());
    if (old.length) {
      try {
        for (const it of runWordingCheck(old.map((text) => ({ text })), { styleSheet }).items) before.set(pointKey(it), (before.get(pointKey(it)) ?? 0) + 1);
      } catch { /* nothing to subtract */ }
    }
    for (const it of found) {
      const k = pointKey(it);
      if (before.get(k)) { before.set(k, before.get(k) - 1); continue; }
      points.push({ ...it, anchor: w.anchor, expected: w.expected, fresh: w.fresh });
    }
  }
  const counts = Object.fromEntries(WORDING_CATEGORIES.map((c) => [c, points.filter((p) => p.category === c).length]));
  const result = { counts, total: points.length };
  const shown = points.slice(0, Math.max(0, max));
  const omitted = points.length - shown.length;
  const out = shown.map((p) => ({
    op: "comment",
    p: p.anchor,
    expected: p.expected,
    text: `Wording (${CATEGORY_WORDS[p.category] ?? p.category}): ${p.note}${p.find ? ` ${p.fresh ? "In the paragraph added after this one" : "At"}: “${p.find.replace(/[\s.;:,]+$/, "")}”.` : ""}`,
  }));
  let line = "";
  if (checked) {
    line = points.length
      ? `${wordingSummary(result).replace("to look at against the firm's style sheet", "to look at against the firm's style sheet in what was written this turn")} Each is an AKLA comment${omitted ? ` (the first ${shown.length})` : ""}.${omitted ? ` …and ${omitted} more wording point${omitted === 1 ? "" : "s"}: ${more}.` : ""}`
      : "Wording: what was written this turn follows the firm's style sheet.";
  }
  const rest = points.slice(shown.length).map((p) => ({ paragraph: p.anchor, note: p.note, find: p.find ?? null, fresh: p.fresh }));
  return { ops: out, result, shown: shown.length, omitted, checked, points, rest, line };
}

/** The new-clause comments a turn's headings were written without, as operations. */
export function newClauseOps({ ops, skeleton }) {
  if (!skeleton) return [];
  try {
    return uncommentedNewClauses({ ops, skeleton }).map((x) => x.op);
  } catch {
    return [];
  }
}

/**
 * Every comment the firm's rules add to a turn's operations, to be applied
 * in the same pass: { ops, wording, newClauses }. `ops` are the extra
 * operations (append them after the turn's own).
 */
export function autoCommentOps({ ops, skeleton = null, styleSheet = null, max = MAX_WORDING_COMMENTS, more } = {}) {
  const newClauses = newClauseOps({ ops, skeleton });
  const wording = wordingCommentOps({ ops, styleSheet, max, ...(more ? { more } : {}) });
  return { ops: [...newClauses, ...wording.ops], wording, newClauses };
}

/**
 * The wording points a turn counted but did not comment on, for the next
 * turn's prompt, so "show me the rest" can be answered: "" when none.
 */
export function moreWordingText(rest, { max = 200 } = {}) {
  if (!Array.isArray(rest) || !rest.length) return "";
  const lines = rest.slice(0, max).map((r) => `- ${r.fresh ? `after ¶${r.paragraph}` : `¶${r.paragraph}`}: ${r.note}${r.find ? ` (“${r.find}”)` : ""}`);
  return `WORDING POINTS YOUR LAST CHANGE COUNTED BUT DID NOT COMMENT ON (against the firm's style sheet; ¶ numbers as the document stood before that change). If the lawyer asks to see them, list them; if asked to fix them, change the wording, re-reading the paragraphs first:\n${lines.join("\n")}${rest.length > max ? `\n- and ${rest.length - max} more.` : ""}`;
}

// ---------------------------------------------------------------- the clause-list check

/** The headings a turn's operations write (write blocks of a heading kind, "# " insert_after). */
export function headingsWrittenBy(ops, skeleton = null) {
  const kinds = !Array.isArray(skeleton) ? skeleton?.headingKinds ?? null : null;
  const isHeading = (kind) => (kinds ? Object.hasOwn(kinds, kind) : /^h[1-4]$|heading/.test(String(kind ?? "")));
  const out = [];
  for (const op of ops ?? []) {
    const kind = opName(op);
    if (kind === "write" && Array.isArray(op.blocks)) for (const b of op.blocks) if (isHeading(b?.kind) && typeof b.text === "string") out.push(words(b.text));
    if (kind === "insert_after" && /^\s*#{1,4}\s+\S/.test(String(op.text ?? ""))) out.push(words(op.text));
  }
  return out;
}

const listOf = (names) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** How the Hub's lawyer confirms an omission: in a reply. */
export function hubConfirmSentence(missing) {
  const first = missing[0];
  return `Ask me to add ${missing.length === 1 ? "it" : "them"}, or confirm the omission by replying "leave out ${first.heading}"${missing.length > 1 ? " (naming each, or \"leave them all out\")" : ""} — or "confirm omission: ${missing.map((m) => m.id).join(", ")}" — and I will file the draft without ${missing.length === 1 ? "it" : "them"}.`;
}

/** How claude.ai confirms an omission: the same call again with confirmedOmissions, once the lawyer says so. */
export function connectorConfirmSentence(tool) {
  return (missing) => `Add ${missing.length === 1 ? "it" : "them"} and send the changes again, or, only once the lawyer confirms the omission, call ${tool} again with the same changes and confirmedOmissions: ${JSON.stringify(missing.map((m) => m.id))}.`;
}

/**
 * The clause-list check on the file about to be stored.
 * @param {object} input
 * @param {Uint8Array} input.bytes the file about to be stored (accepted, for a fill)
 * @param {Uint8Array} [input.baseBytes] the file it was made from: on an edit, only a part present there and missing now stops it
 * @param input.skeleton the clause list (null: no check)
 * @param [input.kinds] the pack's kinds list
 * @param [input.answers] the drafting decisions' answers
 * @param {string[]} [input.confirmedOmissions] item ids the lawyer confirmed may be left out
 * @param {boolean} [input.full] every required part counts (a draft from a shell pack); otherwise only one the file it was made from had
 * @param {boolean} [input.report] a draft from the firm's standard: the reply's line gives the whole clause-list status
 * @param {string} [input.typeName]
 * @param {Array} [input.ops] the turn's operations, to name the new clauses it wrote
 * @param {(missing: Array<{id: string, heading: string}>) => string} [input.confirmHow]
 * @returns {{ result, refused: boolean, blocking: Array, text: string, line: string, record: object } | null}
 */
export function skeletonGate({ bytes, baseBytes = null, skeleton, kinds = null, answers = null, confirmedOmissions = [], full = false, report = full, typeName = null, ops = [], confirmHow = hubConfirmSentence } = {}) {
  if (!skeleton || !itemsOf(skeleton).length || !bytes) return null;
  let result;
  try {
    result = checkSkeleton({ bytes, skeleton, kinds, answers, confirmedOmissions });
  } catch (err) {
    return { result: null, refused: false, blocking: [], text: "", line: `Clause list: the check could not run (${err instanceof Error ? err.message : String(err)}); check the parts in Word.`, record: { status: "error" } };
  }
  // The file it was made from, read the same way: what it had, and the
  // headings it already had that are on no list (the firm's own, or the
  // counterparty's — not this turn's new clauses).
  let before = null;
  try { before = baseBytes ? checkSkeleton({ bytes: baseBytes, skeleton, kinds, answers }) : null; } catch { before = null; }
  let blocking = result.missing;
  let lacked = [];
  if (!full) {
    // Only what the turn takes out stops it; what the file it was made
    // from never had is reported.
    const had = new Set((before?.present ?? []).map((p) => p.id));
    blocking = before ? result.missing.filter((m) => had.has(m.id)) : [];
    lacked = result.missing.filter((m) => !blocking.includes(m));
  }
  const name = typeName ?? (!Array.isArray(skeleton) && skeleton.typeName) ?? "document";
  const written = new Set(headingsWrittenBy(ops, skeleton).map(normaliseHeading));
  const already = new Set((before?.newClauses ?? []).map((n) => normaliseHeading(n.heading)));
  const newClauses = result.newClauses.filter((n) => (report ? !already.has(normaliseHeading(n.heading)) : written.has(normaliseHeading(n.heading))));
  const record = {
    status: blocking.length ? "blocked" : result.status === "blocked" ? "incomplete" : result.status,
    blocking: blocking.map((m) => m.id),
    missing: result.missing.map((m) => m.id),
    confirmed: result.confirmed,
    newClauses: newClauses.map((n) => n.heading),
  };
  if (blocking.length) {
    const parts = blocking.length === 1 ? "this part" : "these parts";
    const text = [
      `Not filed: the firm's ${name} always has ${parts}, and ${full ? "this draft does not" : "this change would take it out"}:`,
      ...blocking.map((m) => `- ${m.sentence}`),
      `Nothing was saved. ${confirmHow(blocking)}`,
    ].join("\n");
    return { result, refused: true, blocking, text, line: "", record };
  }
  const confirmedLine = result.confirmed.length ? ` Left out as confirmed: ${listOf(result.confirmed.map((id) => itemsOf(skeleton).find((it) => it.id === id)?.heading ?? id))}.` : "";
  const newLines = newClauses.map((n) => `- New clause, not in the firm's precedents (it carries an AKLA comment saying so): "${n.heading}".`);
  if (!report) {
    const line = newLines.length || confirmedLine ? [`Clause list:${confirmedLine || " the firm's parts are where they were."}`, ...newLines].join("\n") : "";
    return { result, refused: false, blocking, text: "", line, record };
  }
  const points = [
    ...lacked.map((m) => `- ${m.sentence.replace(/\.$/, "")} (the file it was drafted from does not have it either).`),
    ...[...result.outOfOrder, ...result.unexpected, ...result.optionalUnmarked, ...result.decisionOpen].map((m) => `- ${m.sentence}`),
  ];
  const all = [...points, ...newLines];
  const head = all.length
    ? `Clause list: ${lacked.length ? "nothing this draft took out is missing" : `every part the firm's ${name} requires is present`};${confirmedLine} ${all.length} ${all.length === 1 ? "point" : "points"} to look at:`
    : `Clause list: every part the firm's ${name} expects is present, in the firm's order.${confirmedLine}`;
  const shown = all.slice(0, MAX_POINTS);
  const line = [head, ...shown, ...(all.length > shown.length ? [`- …and ${all.length - shown.length} more.`] : [])].join("\n");
  return { result, refused: false, blocking, text: "", line, record };
}

/**
 * The format check and the clause-list check as the one gate the Hub's
 * store runs through (formatFingerprint.js storeUnlessRefused): refused when
 * either refuses; its text the refusal(s), or else the format line, the
 * clause-list line and the wording line.
 */
export function draftGate(format, skeleton = null, wordingLine = "") {
  if (!format && !skeleton) return null;
  const refused = !!format?.refused || !!skeleton?.refused;
  const text = refused
    ? [format?.refused ? format.text : null, skeleton?.refused ? skeleton.text : null].filter(Boolean).join("\n\n")
    : [format?.text, skeleton?.line, wordingLine].filter(Boolean).join("\n\n");
  return { ...(format ?? {}), refused, text };
}

// ---------------------------------------------------------------- confirmations

const CONFIRMING = /\b(?:leave\s+(?:\w+\s+){0,4}?out|leaving\s+(?:\w+\s+){0,4}?out|left\s+out|omit(?:s|ted|ting)?|omission|confirm(?:s|ed|ing)?|without|no\s+need|n[o\u2019']t\s+need(?:ed)?|not\s+needed|not\s+required|drop|skip)\b/i;
const ADDING = /\b(?:add|put\s+(?:\w+\s+){0,3}?back|restore|reinstate|include|insert)\b/i;
const ALL_OF_THEM = /\b(?:them|it|all|both|these|those|that|this|omissions?|everything)\b/i;

/**
 * The clause-list items a lawyer's message confirms may be left out: [ids].
 * "leave out the Subject line", "confirm no governing law clause", "no
 * Governing Law", "confirm omission: governing_law", or, after a refusal
 * (`pending`, the ids it named), "yes, leave them out". Only items the
 * message names (by heading, label, a synonym or the id), or every pending
 * one when it names none and plainly means them. "Add it back" confirms
 * nothing.
 */
export function omissionsConfirmedIn(message, skeleton, pending = []) {
  const text = String(message ?? "");
  const items = itemsOf(skeleton);
  if (!items.length || !text.trim()) return [];
  const confirming = CONFIRMING.test(text);
  const said = plainWords(text);
  const raw = ` ${text.toLowerCase()} `;
  const candidates = pending.length ? items.filter((it) => pending.includes(it.id)) : items.filter((it) => it.presence !== "optional");
  const named = candidates.filter((it) => {
    const names = itemNames(it).flatMap((n) => [n, n.replace(/\s+(?:line|clause|article|section|part|block)$/, "")]).filter((n) => n.length >= 3);
    // "no Governing Law" says it on its own; any other naming needs a word that confirms.
    if (names.some((n) => said.includes(` no ${n} `))) return true;
    if (!confirming) return false;
    if (new RegExp(`[^a-z0-9_-]${it.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^a-z0-9_-]`).test(raw)) return true;
    return names.some((n) => said.includes(` ${n} `));
  }).map((it) => it.id);
  if (named.length) return [...new Set(named)];
  if (pending.length && confirming && !ADDING.test(text) && ALL_OF_THEM.test(text)) return [...pending];
  return [];
}

export { NEW_CLAUSE_PREFIX };
