// Guided drafting: a document type's decision points, asked one at a time.
//
// The first message of a draft of such a type opens the firm's standard in
// the panel and asks the first question. Each answer is applied to the
// working copy as tracked changes, then the next question is asked. The
// order is chosen so that a question comes after the ones it depends on —
// whether a project is Qualified decides the approval chain and which forms
// of Government support can be offered; the revenue model decides whether
// revenue sharing arises; the financing source decides whether a benchmark
// rate or a financing mix is asked at all. A question an earlier answer
// settles is answered for the associate and applied with it; options an
// earlier answer rules out are not offered.
//
// The RFP questionnaire is AKLA's "Federal PPP RFP — Drafting Options
// Matrix" for Volume I (Tender Procedure) of the federal PPP standard.

// The decisions themselves are data (decisions/<key>.json, read by
// decisions.js): the RFP's moved there word for word on 20 October 2026,
// and every other type's sit beside it. A type's own row
// (document_types.decisions, written by scripts/drafting-packs/
// seed_skeletons.mjs) is preferred when it has one: questionnaireFor.
import { compileQuestionnaire, decisionFiles } from "./decisions.js";

const compiled = (data) => compileQuestionnaire(data);

/** Every questionnaire the data files hold, by key, ready for the engine. */
export const QUESTIONNAIRES = Object.fromEntries(Object.values(decisionFiles()).map((d) => [d.key, compiled(d)]));

const rowCache = new Map();
const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * The questionnaire for a document_types row, ready for the engine, or null:
 * the row's own `decisions` when it has questions; else the questionnaire
 * its `questionnaire` key names; else the data file whose typeName (or
 * alias) is the type's name. A row's decisions are compiled once per
 * content.
 */
export function questionnaireFor(type) {
  const own = type?.decisions;
  const ownQuestions = Array.isArray(own) ? own : own?.questions;
  if (Array.isArray(ownQuestions) && ownQuestions.length) {
    const text = JSON.stringify(own);
    if (!rowCache.has(text)) {
      if (rowCache.size > 100) rowCache.clear();
      const data = Array.isArray(own) ? { key: type.questionnaire ?? `type_${type.id ?? "row"}`, name: `${type.name ?? "Document"} drafting decisions`, questions: own } : own;
      rowCache.set(text, compiled(data));
    }
    return rowCache.get(text);
  }
  if (type?.questionnaire && QUESTIONNAIRES[type.questionnaire]) return QUESTIONNAIRES[type.questionnaire];
  if (!type?.name) return null;
  const file = Object.values(decisionFiles()).find((d) => sameName(d.typeName, type.name) || (d.aliases ?? []).some((a) => sameName(a, type.name)));
  return file ? QUESTIONNAIRES[file.key] ?? null : null;
}

/** The question as the associate sees it: only the options still open. */
function present(q, answers, index, total) {
  const options = q.filter ? q.options.filter((o) => q.filter(o, answers)) : q.options;
  return {
    id: q.id, section: q.section, title: q.title, question: q.question, multi: !!q.multi,
    exclusive: q.exclusive ?? [], options, index, total,
  };
}

/**
 * From the answers so far: the questions that settle themselves next (to be
 * applied with the answer just given) and the next question to ask, or
 * null when there is none left.
 */
export function advance(questionnaire, answers) {
  const next = { ...answers };
  const autos = [];
  const relevant = questionnaire.questions.filter((q) => !q.appliesWhen || q.appliesWhen(next));
  for (const q of questionnaire.questions) {
    if (next[q.id]) continue;
    if (q.appliesWhen && !q.appliesWhen(next)) continue;
    const auto = q.auto?.(next);
    if (auto) {
      const option = q.options.find((o) => o.id === auto);
      next[q.id] = { optionIds: [auto], labels: [option.label], auto: true };
      autos.push({ question: q, optionIds: [auto] });
      continue;
    }
    const position = relevant.findIndex((r) => r.id === q.id) + 1;
    return { answers: next, autos, pending: present(q, next, position, relevant.length) };
  }
  return { answers: next, autos, pending: null };
}

export function startQuestionnaire(questionnaire) {
  const { answers, pending } = advance(questionnaire, {});
  return { key: questionnaire.key, answers, pending, done: !pending };
}

/** Checks an answer against the question asked; returns its labels or an error. */
export function readAnswer(questionnaire, state, answer) {
  const q = questionnaire.questions.find((x) => x.id === state?.pending?.id);
  if (!q || answer?.questionId !== q.id) return { error: "That question is no longer the one being asked. Reload the chat." };
  if (answer.skip) return { question: q, optionIds: [], labels: [], skip: true };
  const open = new Set((state.pending.options ?? []).map((o) => o.id));
  const ids = Array.isArray(answer.optionIds) ? [...new Set(answer.optionIds.map(String))] : [];
  if (!ids.length || ids.some((id) => !open.has(id))) return { error: "Choose one of the options offered." };
  if (!q.multi && ids.length > 1) return { error: "Choose one option." };
  if (q.exclusive?.some((x) => ids.includes(x)) && ids.length > 1) return { error: "That option cannot be combined with the others." };
  return { question: q, optionIds: ids, labels: ids.map((id) => q.options.find((o) => o.id === id).label) };
}

function describeChoice(question, optionIds, label = "RFP") {
  const chosen = optionIds.map((id) => question.options.find((o) => o.id === id)).filter(Boolean);
  const rejected = question.options.filter((o) => !optionIds.includes(o.id));
  return [
    `DECISION: ${question.title}`,
    `WHERE IT SITS IN THE ${label}: ${question.location}`,
    `CHOSEN: ${chosen.map((o) => `${o.label}${o.hint ? ` (${o.hint})` : ""}`).join("; ")}`,
    `NOT CHOSEN: ${rejected.map((o) => o.label).join("; ")}`,
    `BASIS: ${question.basis}`,
  ].join("\n");
}

/**
 * The instruction for one answer turn: the decision given, and any it
 * settled. `questionnaire` (optional) names the document: its documentLabel
 * ("ESCROW AGREEMENT") and applyWhere (where a choice reaches); without
 * them the words are the RFP's, as they always were.
 */
export function answerInstruction(decisions, answers, questionnaire = null) {
  const label = questionnaire?.documentLabel ?? "RFP";
  const where = questionnaire?.applyWhere ?? "the clause named above, the Data Sheet, the Glossary, the Bidding Forms and annexures, and any other clause that depends on it";
  const earlier = Object.entries(answers)
    .filter(([, v]) => !v.skipped && v.labels?.length)
    .map(([id, v]) => `- ${id}: ${v.labels.join("; ")}`)
    .join("\n");
  return `APPLY ${decisions.length === 1 ? "THIS DRAFTING DECISION" : "THESE DRAFTING DECISIONS"} TO THE ${label}. The associate is working through the firm's drafting options questionnaire one decision at a time; each answer is applied to the working copy as tracked changes.

${decisions.map((d) => describeChoice(d.question, d.optionIds, label)).join("\n\n")}

How to apply it:
- Make every change the choice requires, wherever it reaches — ${where}. Search the document for the bracketed alternative and resolve it: keep the chosen wording, remove the brackets and the alternatives not chosen.
- Where the choice makes a clause, form or annexure inapplicable, delete it or mark it "Not Used" in the way the ${label} already does for others.
- Where the choice needs wording the ${label} does not yet have (a mechanism, a procedure, a cross-reference to the Rule or section it rests on), draft it in the ${label}'s own style, briefly.
- Where the choice needs a project-specific figure or date, leave [●].
- Put one AKLA comment on the main clause changed, stating the choice and its legal basis.
- Change nothing else: no restyling, no rewording of unrelated clauses, no changes that belong to other decisions.
- Keep consistent with the decisions already made:
${earlier || "- (none yet)"}

If the relevant paragraphs are not in the listing, request them with the read protocol before giving ops. Reply with one or two sentences saying what you changed and where, then the ops block.`;
}
