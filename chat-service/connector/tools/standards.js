// The firm's standards, for a lawyer's claude.ai: which document types have
// a Word standard (list_document_types), the standard's text and the format
// rules the Hub gives its own model (read_standard), and the drafting
// questionnaire a type carries (get_drafting_decisions), so Claude can ask
// the firm's own drafting questions in prose and carry the answers in its
// conversation. The Hub keeps nothing of this per call: the standard is the
// document_type_templates row the site writes (useDocumentTypeTemplates.ts;
// content_html is plain extracted text now, HTML in rows seeded earlier, so
// both are read), the questionnaire is questionnaire.js, unchanged.
//
// Access: a standard belongs to the firm, not a project (its policies are
// is_firm_member alone, 20260828120000), and the connector has already
// established that the caller is an approved member before any tool runs
// (app.js stillMember), so no further check is made here, as for the law
// library. Nothing is written.

import { z } from "zod";
import { questionnaireFor, startQuestionnaire } from "../../questionnaire.js";
import { withDraftingColumns, DRAFTING_COLUMNS } from "../../draftChecks.js";
import { skeletonFor, itemsOf } from "../../skeletonCheck.js";
import { styleSheetKeyFor } from "../../styleSheets/index.js";
import { MAX_READ_CHARS, DEFAULT_READ_CHARS, str, uuid, when } from "../tools.js";
import { hubBase } from "../hubLinks.js";
import { withPackColumns } from "../../draftingPacks.js";

export const MAX_TYPES = 300;
/** Types a page of list_document_types shows (about 200 chars each with a standard: well under the wrapper's cap). */
export const TYPES_PER_PAGE = 100;
const MAX_RULES_CHARS = 4_000;
// A page of decisions, under the result cap with room for the head and tail.
export const DECISIONS_PAGE_CHARS = 24_000;

/** The Hub page of a type's standard (src/App.tsx, /precedent-library/standardize/:documentTypeId). */
export function standardLink(documentTypeId, hubUrl) {
  if (!documentTypeId) throw new Error("A standard link needs a document type id.");
  return `${hubBase(hubUrl)}/precedent-library/standardize/${documentTypeId}`;
}

export const openStandard = (documentTypeId, hubUrl) => `Open in Hub: ${standardLink(documentTypeId, hubUrl)}`;

/**
 * The line a list or a read gives a type's style sheet and clause list
 * (draftChecks.js: the same the Hub's draft prompt carries), or null when
 * it has neither its own style sheet nor a clause list.
 */
export function firmRulesLine(type) {
  const key = styleSheetKeyFor(type?.name);
  const skeleton = type ? skeletonFor(type) : null;
  const parts = [];
  if (key) parts.push(`its own style sheet ("${key}", on top of the firm-wide one: get_firm_rules with this documentTypeId)`);
  if (skeleton) parts.push(`a clause list of ${itemsOf(skeleton).length} parts in the firm's order, each always, optional or turned on by a decision (open_standard_for_filling lists it; a filing missing an "always" part is refused)`);
  return parts.length ? `the firm's rules for it: ${parts.join("; ")}; get_clause_examples gives the firm's own versions of a clause` : null;
}

/**
 * The standard's text as plain text. A row the site wrote holds extracted
 * text already; a row seeded from a precedent holds HTML, whose blocks
 * become paragraphs, list items lines, cells tab-separated, and whose tags
 * and entities go.
 */
export function plainTextOf(content) {
  const s = String(content ?? "").replace(/\r\n?/g, "\n");
  const text = !/<[a-z][^>]*>/i.test(s)
    ? s
    : s
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<img\b[^>]*>/gi, "[image]")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(?:td|th)>/gi, "\t")
      .replace(/<\/(?:p|h[1-6]|tr|div|blockquote|ul|ol|table|pre|section)>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, "&");
  return text.split("\n").map((l) => l.replace(/ {2,}/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// A standard the Hub can fill is a .docx (server.js hasWordStandard); a row
// with text but no file is a standard the site built or seeded.
const isWordFile = (row) => /\.docx$/i.test(row?.storage_path ?? "");
// PostgREST gives a one-to-one embed as an object; a stub, or an older
// PostgREST, may give an array.
const oneOf = (v) => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const labelsOf = (opts) => opts.map((o) => o.label);
const orList = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);
// A firm pack (draftingPacks.js) is a Word standard with a pack mode: its
// drafts go through open_standard_for_filling and fill_standard_to_project.
const isPack = (row) => isWordFile(row) && (row?.pack_mode === "form" || row?.pack_mode === "shell");
/** The line a list or a read gives a pack: what it is and which tools draft from it. */
export function packLine(mode) {
  return mode === "shell"
    ? "a firm pack (shell: the firm's fixed parts and paragraph kinds; the body is written into it): draft with open_standard_for_filling, then fill_standard_to_project, never save_draft_to_project"
    : "a firm pack (form: the firm's settled text with blanks, and its clause kinds for a new clause): draft with open_standard_for_filling, then fill_standard_to_project, never save_draft_to_project";
}

/**
 * The rules that tie a decision to earlier answers, in words. questionnaire.js
 * keeps them as functions (appliesWhen, auto, filter), each turning on one
 * earlier answer, so each is read off by trying every option of every other
 * decision on its own and reporting what changed.
 */
export function conditionsOf(questionnaire, q) {
  const lines = [];
  const others = questionnaire.questions.filter((o) => o.id !== q.id);
  const one = (other, opt) => ({ [other.id]: { optionIds: [opt.id], labels: [opt.label] } });
  if (q.appliesWhen) {
    const base = !!q.appliesWhen({});
    for (const other of others) {
      const turns = other.options.filter((opt) => !!q.appliesWhen(one(other, opt)) !== base);
      if (turns.length) lines.push(base ? `Not asked when ${other.title} is ${orList(labelsOf(turns))}.` : `Asked only when ${other.title} is ${orList(labelsOf(turns))}.`);
    }
  }
  if (q.auto) {
    for (const other of others) {
      const settles = new Map();
      for (const opt of other.options) {
        const id = q.auto(one(other, opt));
        if (id) settles.set(id, [...(settles.get(id) ?? []), opt.label]);
      }
      for (const [id, by] of settles) lines.push(`Settled as ${q.options.find((o) => o.id === id)?.label ?? id} when ${other.title} is ${orList(by)}; do not ask it then.`);
    }
  }
  if (q.filter) {
    for (const o of q.options) {
      for (const other of others) {
        const drops = other.options.filter((opt) => !q.filter(o, one(other, opt)));
        if (drops.length) lines.push(`${o.label} is not offered when ${other.title} is ${orList(labelsOf(drops))}.`);
      }
    }
  }
  if (q.exclusive?.length) lines.push(`${orList(q.exclusive.map((id) => q.options.find((o) => o.id === id)?.label ?? id))} cannot be combined with another option.`);
  return lines;
}

/** One decision as the lawyer's Claude reads it, numbered by its place in the questionnaire. */
export function decisionText(questionnaire, q, n) {
  const out = [`${n}. ${q.title}`, `   Question: ${q.question}`];
  if (q.location) out.push(`   Where it sits: ${q.location}`);
  if (q.basis) out.push(`   Basis: ${q.basis}`);
  out.push(`   ${q.multi ? "Choose any that apply" : "Choose one"}:`);
  for (const o of q.options) out.push(`   - ${o.label}${o.hint ? ` — ${o.hint}` : ""}`);
  for (const c of conditionsOf(questionnaire, q)) out.push(`   ${c}`);
  return out.join("\n");
}

/**
 * The questionnaire as text, from decision `from` (1-based), as many as fit
 * a page; the reply says where to continue. `type` is the document_types
 * row ({ name }), `standard` its template row or null, `hubUrl` the site.
 */
export function decisionsText(questionnaire, { type, standard, hubUrl, from = 1 }) {
  const qs = questionnaire.questions;
  const total = qs.length;
  const start = Math.min(Math.max(1, from), total);
  const first = startQuestionnaire(questionnaire).pending;
  const head = [
    `${questionnaire.name}: the ${total} drafting decisions the firm's questionnaire asks before ${type.name} is drafted from the Word standard, in the order the Hub asks them. A later decision can be settled, or its options narrowed, by an earlier answer; where that is so, the rule is stated under the decision. Ask the lawyer each decision in prose, one at a time, in this order; skip one an earlier answer settles, and do not offer an option an earlier answer rules out. Carry the answers in this conversation: nothing is kept on the Hub.${first ? ` The Hub asks first: ${first.title}.` : ""}`,
    standard && isWordFile(standard)
      ? `The firm's Word standard for this type is ${standard.filename ?? standard.storage_path}; in the Hub each answer is applied to it as tracked changes. read_standard reads its text.`
      : `This type has no Word standard yet, so the Hub drafts it the ordinary way; the decisions still apply.`,
    openStandard(type.id, hubUrl),
  ];
  const parts = [head.join("\n")];
  let used = parts[0].length;
  let section = null;
  let n = start;
  for (; n <= total; n++) {
    const q = qs[n - 1];
    const block = `${q.section && q.section !== section ? `\n${q.section.toUpperCase()}\n\n` : "\n"}${decisionText(questionnaire, q, n)}`;
    if (used + block.length > DECISIONS_PAGE_CHARS && n > start) break;
    section = q.section ?? section;
    parts.push(block);
    used += block.length;
  }
  if (n <= total) parts.push(`\n[The decisions continue: call get_drafting_decisions again with from: ${n}.]`);
  else {
    if (questionnaire.closing) parts.push(`\nWHEN THE DECISIONS ARE MADE: ${questionnaire.closing}`);
    parts.push("\n[End of the decisions.]");
  }
  return parts.join("\n");
}

export default ({ supabase, hubUrl }) => {
  const needTypeId = (input) => {
    const id = uuid(input.documentTypeId);
    if (!id) throw new Error("documentTypeId must be a document type id (a UUID). list_document_types gives them.");
    return id;
  };

  const typeById = async (id, columns = "id, name") => {
    const { data, error } = await supabase.from("document_types").select(columns).eq("id", id).maybeSingle();
    if (error) throw new Error(`Could not read the document type: ${error.message}`);
    return data ?? null;
  };

  return [
    {
      name: "list_document_types",
      title: "List the firm's document types",
      description: `The document types the Hub knows (Concession Agreement, Share Purchase Agreement, RFP Volume I, …) by category, with their ids, and for each whether the firm holds a Word standard for it (the file, when it was last replaced), whether it has a drafting questionnaire, and whether it has its own style sheet and clause list (the parts the firm always has, in order). Call it before read_standard or get_drafting_decisions, and before drafting a document of a type the firm may have a standard for: the standard, not general knowledge, is what a draft starts from. ${TYPES_PER_PAGE} types a page; the reply says when there is a next page.`,
      inputSchema: {
        page: z.number().int().min(1).optional().describe("Which page of the list, from 1. Default 1."),
      },
      async run(input) {
        // With the pack's mode, and each type's clause list and decisions
        // (each read without its columns until its migration is applied).
        const { data, error } = await withDraftingColumns((withDrafting) => withPackColumns((withPack) => supabase
          .from("document_types")
          .select(`id, name, category, questionnaire${withDrafting ? `, ${DRAFTING_COLUMNS}` : ""}, standard:document_type_templates(filename, updated_at, storage_path${withPack ? ", pack_mode" : ""})`)
          .order("name", { ascending: true })
          .limit(MAX_TYPES)));
        if (error) throw new Error(`Could not list the document types: ${error.message}`);
        const types = (data ?? []).map((t) => ({ ...t, standard: oneOf(t.standard) }));
        if (!types.length) return "The Hub has no document types yet.";
        const byCategory = new Map();
        for (const t of types) {
          const key = str(t.category, 80) ?? "Other";
          byCategory.set(key, [...(byCategory.get(key) ?? []), t]);
        }
        // Category order, then name order within it, as one flat list the
        // pages cut; a category's heading repeats on a new page.
        const flat = [...byCategory.keys()].sort((a, b) => a.localeCompare(b)).flatMap((category) => byCategory.get(category).map((t) => ({ ...t, category })));
        const page = Number.isInteger(input.page) && input.page > 1 ? input.page : 1;
        const pages = Math.ceil(flat.length / TYPES_PER_PAGE);
        if (page > pages) return `The Hub has ${flat.length} document type${flat.length === 1 ? "" : "s"}, on ${pages} page${pages === 1 ? "" : "s"}; there is no page ${page}.`;
        const shown = flat.slice((page - 1) * TYPES_PER_PAGE, page * TYPES_PER_PAGE);
        const blocks = [];
        let category;
        for (const t of shown) {
          if (t.category !== category || blocks.length === 0) { category = t.category; blocks.push(`${blocks.length ? "\n" : ""}${category.toUpperCase()}`); }
          const out = [`- ${t.name}`, `  documentTypeId: ${t.id}`];
          const s = t.standard;
          if (!s) out.push("  no standard yet");
          else {
            out.push(`  ${isWordFile(s) ? "Word standard" : "standard text (no Word file)"}${s.filename ? `: ${s.filename}` : ""}, updated ${when(s.updated_at)}`);
            if (isPack(s)) out.push(`  ${packLine(s.pack_mode)}`);
            out.push(`  ${openStandard(t.id, hubUrl)}`);
          }
          const qn = questionnaireFor(t);
          if (qn) out.push(`  drafting questionnaire: ${qn.questions.length} decisions (get_drafting_decisions)`);
          const rules = firmRulesLine(t);
          if (rules) out.push(`  ${rules}`);
          blocks.push(out.join("\n"));
        }
        const withStandard = types.filter((t) => t.standard).length;
        const withQuestions = types.filter((t) => questionnaireFor(t)).length;
        const withPack = types.filter((t) => isPack(t.standard)).length;
        const head = `${types.length} document type${types.length === 1 ? "" : "s"} on the Hub: ${withStandard} with a standard${withPack ? ` (${withPack} of them a firm pack: a draft of that type is written into the firm's own Word file with open_standard_for_filling and fill_standard_to_project)` : ""}, ${withQuestions} with a drafting questionnaire${pages > 1 ? ` (page ${page} of ${pages})` : ""}. read_standard reads a standard's text; get_drafting_decisions lists a type's drafting decisions.`;
        const tail = page < pages ? `[The list continues: call list_document_types again with page: ${page + 1}.]` : "[End of the list.]";
        return `${head}\n\n${blocks.join("\n")}\n\n${tail}`;
      },
    },
    {
      name: "read_standard",
      title: "Read a firm standard",
      description: `The text of the firm's standard for one document type (the Word file the Hub fills when it drafts that type), in slices of up to ${MAX_READ_CHARS.toLocaleString("en")} characters, with the format rules the Hub gives its own model (numbering scheme, headings, body font), and whether the type has its own style sheet and clause list (open_standard_for_filling gives both; get_firm_rules the style sheet). Use it to draft a document of that type in the firm's own words and order, or to check a clause against the standard. Start at from: 0; the reply says where to continue. list_document_types gives the id and says which types have a standard.`,
      inputSchema: {
        documentTypeId: z.string().describe("The document type's id, from list_document_types."),
        from: z.number().int().min(0).optional().describe("Character offset to start at. Default 0."),
        chars: z.number().int().min(1).optional().describe(`How many characters to return, at most ${MAX_READ_CHARS}. Default ${DEFAULT_READ_CHARS}.`),
      },
      async run(input) {
        const id = needTypeId(input);
        const { data: row, error } = await withPackColumns((withPack) => supabase
          .from("document_type_templates")
          .select(`content_html, format_rules, filename, storage_path, updated_at${withPack ? ", pack_mode" : ""}, document_type:document_types(id, name, questionnaire)`)
          .eq("document_type_id", id)
          .maybeSingle());
        if (error) throw new Error(`Could not read the standard: ${error.message}`);
        if (!row) {
          const type = await typeById(id);
          if (!type) throw new Error("There is no document type with that id. list_document_types gives them.");
          return `${type.name} has no standard yet. list_document_types shows which types have one; search_precedents finds the firm's past documents of this type.`;
        }
        const type = oneOf(row.document_type) ?? { id, name: "This document type" };
        const text = plainTextOf(row.content_html);
        const label = `the firm's standard for ${type.name}${row.filename ? ` (${row.filename}${isWordFile(row) ? ", a Word file" : ""})` : ""}`;
        if (!text) return `${label} holds no text the Hub could read.\n${openStandard(type.id, hubUrl)}`;
        const from = Number.isInteger(input.from) && input.from > 0 ? input.from : 0;
        const chars = Math.min(MAX_READ_CHARS, Number.isInteger(input.chars) && input.chars > 0 ? input.chars : DEFAULT_READ_CHARS);
        if (from >= text.length) return `${label} is ${text.length.toLocaleString("en")} characters long; there is nothing at ${from.toLocaleString("en")}.`;
        const end = Math.min(text.length, from + chars);
        const head = [`${label[0].toUpperCase()}${label.slice(1)}, updated ${when(row.updated_at)} — characters ${(from + 1).toLocaleString("en")}–${end.toLocaleString("en")} of ${text.length.toLocaleString("en")}.`];
        if (questionnaireFor(type)) head.push(`This type has a drafting questionnaire: get_drafting_decisions lists its decisions.`);
        if (isPack(row)) head.push(`This standard is ${packLine(row.pack_mode)}.`);
        const firm = firmRulesLine(type);
        if (firm) head.push(`${firm[0].toUpperCase()}${firm.slice(1)}.`);
        head.push(openStandard(type.id, hubUrl));
        const rules = str(row.format_rules, MAX_RULES_CHARS);
        if (rules) head.push("", `FORMAT RULES (how the Word file is laid out; a draft of this type follows them):\n${rules}`);
        const tail = end < text.length ? `[The standard continues: call read_standard again with from: ${end}.]` : "[End of the standard.]";
        return `${head.join("\n")}\n\nTEXT:\n\n${text.slice(from, end)}\n\n${tail}`;
      },
    },
    {
      name: "get_drafting_decisions",
      title: "A type's drafting decisions",
      description: "The firm's drafting questionnaire for one document type: the decisions a lawyer settles before the document is drafted from the Word standard (for the federal PPP RFP Volume I: modality, approvals, procurement, revenue, support and financing, bidders, securities, land and KPIs), each with the question, where it sits in the standard, the options with their notes, the legal basis, and the rules by which an earlier answer settles it or narrows its options. Use it to ask the lawyer the firm's own questions in prose, one at a time, before drafting; the answers stay in your conversation. Long questionnaires come in pages: from is the decision number to start at.",
      inputSchema: {
        documentTypeId: z.string().describe("The document type's id, from list_document_types."),
        from: z.number().int().min(1).optional().describe("The decision number to start at. Default 1."),
      },
      async run(input) {
        const id = needTypeId(input);
        // The type's own decisions when it has them (read without the column
        // until 20261021100000 is applied), else its questionnaire key, else
        // the data file of its name (questionnaire.js questionnaireFor).
        const type = await withDraftingColumns(async (withDrafting) => {
          const { data, error } = await supabase.from("document_types").select(`id, name, questionnaire${withDrafting ? ", decisions" : ""}, standard:document_type_templates(filename, storage_path)`).eq("id", id).maybeSingle();
          return { data, error };
        }).then(({ data, error }) => {
          if (error) throw new Error(`Could not read the document type: ${error.message}`);
          return data ?? null;
        });
        if (!type) throw new Error("There is no document type with that id. list_document_types gives them.");
        const questionnaire = questionnaireFor(type);
        if (!questionnaire) return `${type.name} has no drafting questionnaire. list_document_types shows which types have one; a draft of this type starts from read_standard and the facts the lawyer gives.`;
        const from = Number.isInteger(input.from) && input.from > 0 ? input.from : 1;
        return decisionsText(questionnaire, { type, standard: oneOf(type.standard), hubUrl, from });
      },
    },
  ];
};
