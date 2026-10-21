// A document type's drafting decisions as data (docs/drafting-fidelity-plan-
// 2026-10-19.md, "How it will work: the clauses", item 2, and Appendix F).
//
// Each type's decisions are a file chat-service/decisions/<key>.json, copied
// into document_types.decisions by scripts/drafting-packs/seed_skeletons.mjs:
//   { key, typeName, source, name, closing, documentLabel?, applyWhere?,
//     questions: [{ id, section, title, question, location, basis, multi?,
//                   exclusive?, options: [{ id, label, hint? }],
//                   appliesWhen?, auto?, hide? }] }
// The rules that tie a decision to earlier answers are conditions:
//   { "is": [questionId, optionId, …] }   the answer is one of these options
//   { "answered": questionId }            the question was answered, not skipped
//   { "not": cond } · { "all": [cond…] } · { "any": [cond…] }
// - appliesWhen: the question is asked only when the condition holds;
// - auto: [{ when, then }], the first whose condition holds settles the
//   question as option `then`, applied with the answer that settled it;
// - hide: [{ options, when }], options not offered while `when` holds.
// compileQuestionnaire turns them into the functions questionnaire.js's
// engine has always called (appliesWhen(answers), auto(answers) → option id
// or null, filter(option, answers) → offered), so the engine and the
// connector's conditionsOf read data and code alike.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DECISIONS_DIR = join(HERE, "decisions");

const is = (answers, questionId, ...optionIds) => (answers[questionId]?.optionIds ?? []).some((o) => optionIds.includes(o));
const answered = (answers, questionId) => !!answers[questionId] && !answers[questionId].skipped;

/** Whether a condition holds for the answers so far. */
export function holds(cond, answers) {
  if (!cond || typeof cond !== "object") throw new Error(`Not a condition: ${JSON.stringify(cond)}`);
  if (Array.isArray(cond.is)) return is(answers, cond.is[0], ...cond.is.slice(1));
  if (typeof cond.answered === "string") return answered(answers, cond.answered);
  if (cond.not) return !holds(cond.not, answers);
  if (Array.isArray(cond.all)) return cond.all.every((c) => holds(c, answers));
  if (Array.isArray(cond.any)) return cond.any.some((c) => holds(c, answers));
  throw new Error(`Unknown condition: ${JSON.stringify(cond)}`);
}

/** The question ids a condition reads. */
function readsOf(cond, out = new Set()) {
  if (!cond || typeof cond !== "object") return out;
  if (Array.isArray(cond.is)) out.add(cond.is[0]);
  if (typeof cond.answered === "string") out.add(cond.answered);
  if (cond.not) readsOf(cond.not, out);
  for (const c of [...(cond.all ?? []), ...(cond.any ?? [])]) readsOf(c, out);
  return out;
}

/** The option ids an { is } condition names, by question. */
function namedOptions(cond, out = []) {
  if (!cond || typeof cond !== "object") return out;
  if (Array.isArray(cond.is)) out.push([cond.is[0], cond.is.slice(1)]);
  if (cond.not) namedOptions(cond.not, out);
  for (const c of [...(cond.all ?? []), ...(cond.any ?? [])]) namedOptions(c, out);
  return out;
}

/**
 * The questions of a decisions object (or a bare array of questions) with
 * their rules compiled to the engine's functions. Fields the engine does not
 * read are kept as they are.
 */
export function compileQuestionnaire(data) {
  const src = Array.isArray(data) ? { questions: data } : data;
  if (!src || !Array.isArray(src.questions)) throw new Error("A questionnaire needs a questions list.");
  const questions = src.questions.map((q) => {
    const { appliesWhen, auto, hide, ...rest } = q;
    const out = { ...rest };
    if (appliesWhen) out.appliesWhen = (a) => holds(appliesWhen, a);
    if (auto?.length) out.auto = (a) => auto.find((r) => holds(r.when, a))?.then ?? null;
    if (hide?.length) out.filter = (o, a) => !hide.some((h) => h.options.includes(o.id) && holds(h.when, a));
    return out;
  });
  const { questions: _, ...head } = src;
  return { ...head, questions };
}

/**
 * Problems with a decisions object, as sentences ([] when it is sound):
 * unique question and option ids, a question and options for each, every
 * rule naming a question that comes earlier and options it has, every auto
 * result an option of its own question.
 */
export function validateDecisions(data) {
  const problems = [];
  const qs = Array.isArray(data) ? data : data?.questions;
  if (!Array.isArray(qs) || !qs.length) return ["The decisions have no questions."];
  const seen = new Map();
  for (const [i, q] of qs.entries()) {
    const where = `Decision ${i + 1}${q?.id ? ` (${q.id})` : ""}`;
    if (!q?.id) { problems.push(`${where} has no id.`); continue; }
    if (seen.has(q.id)) problems.push(`${where}: the id is used twice.`);
    for (const f of ["title", "question"]) if (!q[f]) problems.push(`${where} has no ${f}.`);
    if (!Array.isArray(q.options) || q.options.length < 2) problems.push(`${where} needs at least two options.`);
    const optIds = new Set();
    for (const o of q.options ?? []) {
      if (!o?.id || !o?.label) problems.push(`${where}: an option has no id or label.`);
      if (optIds.has(o.id)) problems.push(`${where}: option "${o.id}" is used twice.`);
      optIds.add(o.id);
    }
    const conds = [q.appliesWhen, ...(q.auto ?? []).map((r) => r.when), ...(q.hide ?? []).map((h) => h.when)].filter(Boolean);
    for (const c of conds) {
      try { holds(c, {}); } catch (e) { problems.push(`${where}: ${e.message}`); continue; }
      for (const id of readsOf(c)) if (!seen.has(id)) problems.push(`${where}: a rule reads "${id}", which is not an earlier decision.`);
      for (const [id, opts] of namedOptions(c)) {
        const other = seen.get(id);
        if (other) for (const o of opts) if (!other.options.some((x) => x.id === o)) problems.push(`${where}: a rule names option "${o}", which decision "${id}" does not have.`);
      }
    }
    for (const r of q.auto ?? []) if (!optIds.has(r.then)) problems.push(`${where}: auto settles it as "${r.then}", which is not one of its options.`);
    for (const h of q.hide ?? []) for (const o of h.options ?? []) if (!optIds.has(o)) problems.push(`${where}: hide names option "${o}", which is not one of its options.`);
    for (const x of q.exclusive ?? []) if (!optIds.has(x)) problems.push(`${where}: exclusive names option "${x}", which is not one of its options.`);
    seen.set(q.id, q);
  }
  return problems;
}

let fileCache = null;
/** Every decisions file, by key, as data: { key → decisions }. */
export function decisionFiles(dir = DECISIONS_DIR) {
  if (dir === DECISIONS_DIR && fileCache) return fileCache;
  const out = {};
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
      out[d.key ?? f.replace(/\.json$/, "")] = d;
    }
  } else {
    console.error(`decisions: ${dir} is missing; no type has drafting decisions until it is deployed.`);
  }
  if (dir === DECISIONS_DIR) fileCache = out;
  return out;
}
