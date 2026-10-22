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
import { FIRM_MARKDOWN_RULES, COMPLETENESS_RULES, FIRM_STYLE_CORE, styleSheetText, lookingUpRules } from "../../firmRules.js";
import { uuid } from "../tools.js";

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

export const CONNECTOR_SHAPE_NOTE = "The Hub turns Markdown in this shape into the firm's Word file when the document is saved there. In claude.ai, write the document as Markdown in exactly this shape and file it as FILING says; do not wrap it in the Hub's <artifact> tag.";

// The owner's decision of 22 Oct 2026, "force connector drafting wherever
// possible": a firm document made in claude.ai ends up filed in the Hub,
// never left as a file in the chat. The server instructions (app.js) say
// the same in one sentence for a sign-in that may save.
export const CONNECTOR_FILING = "FILING: every firm document the lawyer asks you to draft is filed in the Hub, never handed over only as a file or artifact in the chat. Use fill_standard_to_project when its type has a standard or pack (list_document_types says which; open_standard_for_filling first), otherwise save_draft_to_project; a file you produced in your code sandbox (with a skill) goes in with upload_file_to_project. Ask which project if that is not clear. Then give the \"Open in Hub:\" address, written out in full on its own line.";

const REVIEWING = "REVIEWING: read the document with get_document_summary and then read_document in slices before you say anything about it. Every point you raise names the clause it concerns, and, where it turns on a law or a precedent, cites the passage as above; keep what the document says apart from what you recommend.";

/**
 * The rules for one task, as get_firm_rules returns them. A draft carries
 * the firm's style sheet: the firm-wide core, or, for a kind of document
 * (`typeName`), the core and what differs for that kind (firmRules.js
 * styleSheetText, the words the Hub's own draft prompt carries).
 */
export function firmRulesText(task, { typeName = null } = {}) {
  const parts = [`AKLA's rules for ${task === "draft" ? "drafting" : task === "review" ? "reviewing" : "answering"} from the Hub. Follow them for the whole task.`, "", CONNECTOR_GROUNDING, "", CONNECTOR_SOURCING, "", CONNECTOR_CITING];
  if (task === "draft") parts.push("", COMPLETENESS_RULES, "", FIRM_MARKDOWN_RULES, "", CONNECTOR_SHAPE_NOTE, "", CONNECTOR_FILING, "", typeName ? styleSheetText(typeName) : FIRM_STYLE_CORE);
  if (task === "review") parts.push("", REVIEWING);
  return parts.join("\n");
}

export default ({ supabase } = {}) => [
  {
    name: "get_firm_rules",
    title: "The firm's rules",
    description: "AKLA's rules for working from the Hub: search the firm's precedents and law library before drafting or answering, cite every passage as [Source n], quote a statute only from a passage in front of you, and (for a draft) the house Markdown shape, the rule that a document is written in full, the rule that every firm document is filed in the Hub (fill_standard_to_project, save_draft_to_project or upload_file_to_project) rather than left as a file in the chat, and how the firm writes (its style sheet: defined terms, numbers, money, dates, cross-references, spelling, voice). Call it once at the start of a drafting, answering or review task and follow what it returns. Takes `task`: draft (the full drafting rules), answer (sourcing and citing) or review; for a draft of a kind of document the firm has a standard for, pass its documentTypeId (list_document_types) for that kind's own style sheet.",
    inputSchema: {
      task: z.enum(TASKS).optional().describe("What the rules are for: draft, answer or review. Default draft."),
      documentTypeId: z.string().optional().describe("Optional, for a draft: the document type's id from list_document_types, for how the firm writes that kind of document in particular."),
    },
    async run(input) {
      const task = TASKS.includes(input.task) ? input.task : "draft";
      let typeName = null;
      if (task === "draft" && input.documentTypeId != null && String(input.documentTypeId).trim() !== "") {
        const id = uuid(input.documentTypeId);
        if (!id) throw new Error("documentTypeId must be a document type id (a UUID). list_document_types gives them.");
        const { data, error } = await supabase.from("document_types").select("id, name").eq("id", id).maybeSingle();
        if (error) throw new Error(`Could not read the document type: ${error.message}`);
        if (!data) throw new Error("There is no document type with that id. list_document_types gives them.");
        typeName = data.name;
      }
      return firmRulesText(task, { typeName });
    },
  },
];
