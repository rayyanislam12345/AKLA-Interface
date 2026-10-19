// get_firm_rules: the Hub's own rules, for a lawyer's claude.ai. A Project
// in claude.ai whose instructions say "call get_firm_rules first" then
// drafts and answers the way the Hub's assistant does: the precedents and
// the law library searched first, every passage cited as [Source n], a
// statute quoted only from a passage in front of it, the house Markdown
// shape, and a draft finished rather than gestured at. The words are the
// same strings server.js prompts with (firmRules.js at the service root),
// so the two cannot drift; only the citing convention differs, because a
// tool result here numbers its sources from 1 each call.

import { z } from "zod";
import { FIRM_MARKDOWN_RULES, COMPLETENESS_RULES, lookingUpRules } from "../../firmRules.js";

export const TASKS = ["draft", "answer", "review"];

// Every tool the connector offers (tools.js ALL_TOOL_NAMES), in the order a
// task meets them; the registry test pins the opening.
const TOOL_NAMES = "search_precedents, search_law_library, read_act_section, and for a project list_projects, get_project_overview, find_document_by_title, list_project_documents, search_project_documents, search_everything, read_document, get_document_summary, get_document_checks and compare_document_versions; also list_acts and get_act_outline for what the law library holds, list_precedents, find_precedent_clauses and read_precedent for the precedent library whole, and list_document_types, read_standard and get_drafting_decisions for the firm's standards";

// The Hub retrieves passages for every message before its model answers,
// so its LOOKING THINGS UP sentence is conditional ("when the passages in
// front of you do not settle it") and its grounding rule sits in the stable
// prompt (server.js). In claude.ai nothing is retrieved up front and that
// prompt is not there, so the search comes first, unconditionally, in the
// stable prompt's own words.
export const CONNECTOR_GROUNDING = "SEARCH FIRST: before you draft or answer on a point that turns on a law, a precedent or a project's documents, search: search_precedents (or find_precedent_clauses) and search_law_library, and search_project_documents for a project; nothing is retrieved for you here. Ground every legal statement in a passage you have been shown and cite it by number; distinguish what the project's documents say, what the firm's precedent shows, and what the law itself provides, naming the Act and section when you rely on a statute. If the sources do not answer the question, say so rather than guessing.";

// The Hub's LOOKING THINGS UP sentence, minus the online lookup the Hub chat
// has and this connector does not.
export const CONNECTOR_SOURCING = lookingUpRules({ toolNames: TOOL_NAMES, matterId: "project", editTools: false })
  .replace(" look_up_law_online is slow (tens of seconds): use it only when the law library does not hold the law you need.", "")
  .replace(" or this project's documents say", " or a project's documents say");

// The Hub's CITING sentence, said for a connector: numbers restart with every
// tool result, so a citation names the source as well as the number.
export const CONNECTOR_CITING = "CITING: every passage a tool returns is labelled [Source n], numbered from 1 within that result; the numbers are not chat-wide, so a later call starts again at 1. Cite a passage as [Source n] with its number and the Act or document its label names (e.g. [Source 2] Companies Act, 2017, s. 199), and only numbers you have been shown. Quote statutory text only from a passage in front of you, word for word; to quote a provision you have not been shown in full, read it with read_act_section first. In a document itself (its text and AKLA comments) name the Act and section or the document instead, never \"[Source n]\". Pass on the \"Open in Hub:\" address of what you relied on, so the lawyer can open it.";

export const CONNECTOR_SHAPE_NOTE = "The Hub turns Markdown in this shape into the firm's Word file when the document is saved there. In claude.ai, give the document as Markdown in exactly this shape, on its own (in claude.ai's own document panel if it offers one); do not wrap it in the Hub's <artifact> tag.";

const REVIEWING = "REVIEWING: read the document with get_document_summary and then read_document in slices before you say anything about it. Every point you raise names the clause it concerns, and, where it turns on a law or a precedent, cites the passage as above; keep what the document says apart from what you recommend.";

/** The rules for one task, as get_firm_rules returns them. */
export function firmRulesText(task) {
  const parts = [`AKLA's rules for ${task === "draft" ? "drafting" : task === "review" ? "reviewing" : "answering"} from the Hub. Follow them for the whole task.`, "", CONNECTOR_GROUNDING, "", CONNECTOR_SOURCING, "", CONNECTOR_CITING];
  if (task === "draft") parts.push("", COMPLETENESS_RULES, "", FIRM_MARKDOWN_RULES, "", CONNECTOR_SHAPE_NOTE);
  if (task === "review") parts.push("", REVIEWING);
  return parts.join("\n");
}

export default [
  {
    name: "get_firm_rules",
    title: "The firm's rules",
    description: "AKLA's rules for working from the Hub: search the firm's precedents and law library before drafting or answering, cite every passage as [Source n], quote a statute only from a passage in front of you, and (for a draft) the house Markdown shape and the rule that a document is written in full. Call it once at the start of a drafting, answering or review task and follow what it returns. Takes `task`: draft (the full drafting rules), answer (sourcing and citing) or review.",
    inputSchema: {
      task: z.enum(TASKS).optional().describe("What the rules are for: draft, answer or review. Default draft."),
    },
    async run(input) {
      const task = TASKS.includes(input.task) ? input.task : "draft";
      return firmRulesText(task);
    },
  },
];
