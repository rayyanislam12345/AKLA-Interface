// Clause lists and drafting decisions as data (docs/drafting-fidelity-plan-
// 2026-10-19.md, slice 4): skeletons/<key>.json and decisions/<key>.json are
// sound; the RFP questionnaire asks exactly what it asked when it lived in
// code (compared with the frozen copy in fixtures/rfpQuestionnaireLegacy.js:
// the same questions, the same rules on every answer tried, the same walk
// through the engine, the same instruction text, the same rules in words);
// questionnaireFor prefers the type row's decisions; skeletonCheck.js finds
// a letter's missing Subject line by its kind and words, an agreement's
// missing Governing Law, an extra heading as a new clause, "Not Used" for an
// optional article; and the new-clause rule finds a heading written in a
// turn without its comment. seed_skeletons.mjs is run against a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import LEGACY, { legacyAnswerInstruction } from './fixtures/rfpQuestionnaireLegacy.js';
import { QUESTIONNAIRES, questionnaireFor, startQuestionnaire, advance, readAnswer, answerInstruction } from '../questionnaire.js';
import { compileQuestionnaire, decisionFiles, validateDecisions, holds } from '../decisions.js';
import {
  checkSkeleton, newClauseFindings, uncommentedNewClauses, newClauseComment, NEW_CLAUSE_PREFIX,
  skeletonFiles, skeletonFor, validateSkeleton, normaliseHeading, documentParagraphs, skeletonText, itemsOf,
} from '../skeletonCheck.js';
import { conditionsOf } from '../connector/tools/standards.js';
import { NEW_CLAUSE_COMMENT } from '../draftingPacks.js';
import { plan, seedSkeletons, NAMED_TYPES, parseArgs as seedArgs } from '../../scripts/drafting-packs/seed_skeletons.mjs';
import { loadPackTypes } from '../../scripts/drafting-packs/upload_packs.mjs';

const RFP = QUESTIONNAIRES.rfp_federal_ppp;
const SKELETONS = skeletonFiles();
const DECISIONS = decisionFiles();
const decisionsOf = (s) => Object.values(DECISIONS).find((d) => d.typeName.toLowerCase() === s.typeName.toLowerCase()) ?? null;

// A small seeded generator, so a failure names a case that can be run again.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const pickOne = (r, list) => list[Math.floor(r() * list.length)];

// ---------------------------------------------------------------------------
// The data files

test('every kind of document in wave 1 has a clause list and decisions, plus the Concession Agreement and the RFP', () => {
  const packs = Object.keys(loadPackTypes());
  for (const key of [...packs, ...Object.keys(NAMED_TYPES)]) {
    assert.ok(SKELETONS[key], `skeletons/${key}.json exists`);
    assert.ok(decisionsOf(SKELETONS[key]), `decisions for ${SKELETONS[key].typeName} exist`);
  }
  assert.equal(Object.keys(SKELETONS).length, 14);
});

test('each clause list is sound: unique ids, known presences, every decision it names exists with the options it names, and it says where it came from', () => {
  for (const [key, s] of Object.entries(SKELETONS)) {
    assert.deepEqual(validateSkeleton(s, decisionsOf(s)), [], key);
    assert.equal(s.key, key);
    assert.ok(s.source && s.source.length > 80, `${key} notes its source`);
    const ids = itemsOf(s).map((it) => it.id);
    assert.equal(new Set(ids).size, ids.length, `${key}: ids unique`);
    assert.ok(itemsOf(s).some((it) => it.presence === 'always' || it.presence === 'decision'), `${key} has parts the firm requires, always or by decision`);
  }
  // A list with a duplicate id, a missing decision and a bad pattern is refused in words.
  const bad = { items: [
    { id: 'a', heading: 'A', level: 1, presence: 'always', match: 'heading' },
    { id: 'a', heading: 'B', level: 1, presence: 'decision', decision: 'nope', match: 'heading' },
    { id: 'c', heading: 'C', level: 0, presence: 'always', match: 'slot', pattern: '(' },
  ] };
  const problems = validateSkeleton(bad, { questions: [{ id: 'x', title: 'X', question: 'X?', options: [{ id: 'p', label: 'P' }, { id: 'q', label: 'Q' }] }] });
  assert.ok(problems.some((p) => /id is used twice/.test(p)));
  assert.ok(problems.some((p) => /decision "nope" is not in the type's decisions/.test(p)));
  assert.ok(problems.some((p) => /not a valid regular expression/.test(p)));
});

test('each decisions file is sound and compiles for the engine; arbitration is asked with no default wherever there is a dispute clause', () => {
  for (const [key, d] of Object.entries(DECISIONS)) {
    assert.deepEqual(validateDecisions(d), [], key);
    const q = compileQuestionnaire(d);
    const s = startQuestionnaire(q);
    assert.ok(s.pending, `${key} asks a first question`);
  }
  for (const key of ['escrow', 'framework', 'ie-agreement', 'ia-agreement', 'amendment', 'concession-agreement']) {
    const arb = DECISIONS[key].questions.find((q) => q.id === 'arbitration_forum');
    assert.ok(arb, `${key} asks the arbitration forum`);
    assert.ok(!arb.auto && !arb.appliesWhen, `${key}: the forum is never settled for the lawyer`);
    assert.ok(arb.options.some((o) => /Arbitration Act, 1940/.test(o.label)) && arb.options.some((o) => /SIAC/.test(o.label)) && arb.options.some((o) => o.id === 'other'));
  }
  // No pack's decisions name a province or a provincial government (the standing rule of 20 October).
  for (const [key, d] of Object.entries(DECISIONS)) {
    if (key === 'rfp_federal_ppp') continue; // moved word for word
    assert.doesNotMatch(JSON.stringify(d), /\b(Sindh|Punjab|Balochistan|Khyber|GoS|GoP)\b/, key);
  }
  // A rule that reads a later decision, or an auto result that is not an option, is refused.
  const problems = validateDecisions({ questions: [
    { id: 'a', title: 'A', question: 'A?', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], appliesWhen: { is: ['b', 'p'] } },
    { id: 'b', title: 'B', question: 'B?', options: [{ id: 'p', label: 'P' }, { id: 'q', label: 'Q' }], auto: [{ when: { is: ['a', 'z'] }, then: 'r' }] },
  ] });
  assert.ok(problems.some((p) => /reads "b", which is not an earlier decision/.test(p)));
  assert.ok(problems.some((p) => /names option "z"/.test(p)));
  assert.ok(problems.some((p) => /settles it as "r"/.test(p)));
});

test('conditions read answers the way the engine always has', () => {
  const a = { q1: { optionIds: ['x'], labels: ['X'] }, q2: { optionIds: [], labels: [], skipped: true } };
  assert.equal(holds({ is: ['q1', 'x', 'y'] }, a), true);
  assert.equal(holds({ is: ['q1', 'y'] }, a), false);
  assert.equal(holds({ answered: 'q1' }, a), true);
  assert.equal(holds({ answered: 'q2' }, a), false);
  assert.equal(holds({ not: { is: ['q3', 'x'] } }, a), true);
  assert.equal(holds({ all: [{ answered: 'q1' }, { not: { is: ['q1', 'x'] } }] }, a), false);
  assert.equal(holds({ any: [{ is: ['q2', 'x'] }, { is: ['q1', 'x'] }] }, a), true);
  assert.throws(() => holds({ maybe: 1 }, a), /Unknown condition/);
});

// ---------------------------------------------------------------------------
// The RFP questionnaire, unchanged by the move

test('the RFP questionnaire from data has the same questions, words and options as the code had', () => {
  assert.equal(RFP.key, LEGACY.key);
  assert.equal(RFP.name, LEGACY.name);
  assert.equal(RFP.closing, LEGACY.closing);
  assert.equal(RFP.questions.length, LEGACY.questions.length);
  assert.equal(RFP.questions.length, 30);
  RFP.questions.forEach((q, i) => {
    const old = LEGACY.questions[i];
    for (const f of ['id', 'section', 'title', 'question', 'location', 'basis', 'multi']) assert.equal(q[f], old[f], `${old.id}.${f}`);
    assert.deepEqual(q.options, old.options, `${old.id}.options`);
    assert.deepEqual(q.exclusive, old.exclusive, `${old.id}.exclusive`);
    for (const f of ['appliesWhen', 'auto', 'filter']) assert.equal(typeof q[f], typeof old[f], `${old.id}.${f} present in both or neither`);
  });
  assert.equal(questionnaireFor({ questionnaire: 'rfp_federal_ppp' }), RFP);
});

test('every rule gives the same result as the code on hundreds of answer sets', () => {
  const r = rng(20261020);
  const qs = LEGACY.questions;
  for (let n = 0; n < 600; n++) {
    const answers = {};
    for (const q of qs) {
      const roll = r();
      if (roll < 0.45) continue;
      if (roll < 0.5) { answers[q.id] = { optionIds: [], labels: [], skipped: true }; continue; }
      const ids = q.multi ? q.options.filter(() => r() < 0.35).map((o) => o.id) : [pickOne(r, q.options).id];
      if (!ids.length) ids.push(q.options[0].id);
      answers[q.id] = { optionIds: ids, labels: ids.map((id) => q.options.find((o) => o.id === id).label) };
    }
    qs.forEach((old, i) => {
      const q = RFP.questions[i];
      if (old.appliesWhen) assert.equal(q.appliesWhen(answers), old.appliesWhen(answers), `${old.id}.appliesWhen #${n}`);
      if (old.auto) assert.equal(q.auto(answers), old.auto(answers), `${old.id}.auto #${n}`);
      if (old.filter) for (const o of old.options) assert.equal(q.filter(o, answers), old.filter(o, answers), `${old.id}.filter(${o.id}) #${n}`);
    });
  }
});

test('the engine walks the same way through the data as through the code: same questions, same settled answers, same instructions', () => {
  const r = rng(7);
  for (let walk = 0; walk < 150; walk++) {
    let a = startQuestionnaire(RFP);
    let b = startQuestionnaire(LEGACY);
    assert.deepEqual(a, b, `walk ${walk}: start`);
    let guard = 0;
    while (a.pending && guard++ < 60) {
      const p = a.pending;
      const skip = r() < 0.08;
      const ids = skip ? [] : p.multi ? (() => { const open = p.options.filter((o) => !p.exclusive.includes(o.id)); const c = open.filter(() => r() < 0.4).map((o) => o.id); return c.length ? c : [pickOne(r, p.options).id]; })() : [pickOne(r, p.options).id];
      const answer = skip ? { questionId: p.id, skip: true } : { questionId: p.id, optionIds: ids };
      const ra = readAnswer(RFP, a, answer);
      const rb = readAnswer(LEGACY, b, answer);
      assert.deepEqual({ ...ra, question: ra.question?.id }, { ...rb, question: rb.question?.id }, `walk ${walk}: read ${p.id}`);
      const record = (x) => (x.skip ? { optionIds: [], labels: [], skipped: true } : { optionIds: x.optionIds, labels: x.labels });
      const na = advance(RFP, { ...a.answers, [p.id]: record(ra) });
      const nb = advance(LEGACY, { ...b.answers, [p.id]: record(rb) });
      assert.deepEqual(na.answers, nb.answers, `walk ${walk}: answers after ${p.id}`);
      assert.deepEqual(na.pending, nb.pending, `walk ${walk}: next after ${p.id}`);
      assert.deepEqual(na.autos.map((x) => [x.question.id, x.optionIds]), nb.autos.map((x) => [x.question.id, x.optionIds]), `walk ${walk}: settled after ${p.id}`);
      if (!ra.skip) {
        const decided = [{ question: ra.question, optionIds: ra.optionIds }, ...na.autos];
        const decidedOld = [{ question: rb.question, optionIds: rb.optionIds }, ...nb.autos];
        assert.equal(answerInstruction(decided, na.answers), legacyAnswerInstruction(decidedOld, nb.answers), `walk ${walk}: instruction for ${p.id}`);
      }
      a = { key: RFP.key, answers: na.answers, pending: na.pending, done: !na.pending };
      b = { key: LEGACY.key, answers: nb.answers, pending: nb.pending, done: !nb.pending };
    }
    assert.equal(a.pending, null, `walk ${walk} finishes`);
  }
});

test('the connector states the same rules in words from the data as from the code', () => {
  RFP.questions.forEach((q, i) => assert.deepEqual(conditionsOf(RFP, q), conditionsOf(LEGACY, LEGACY.questions[i]), q.id));
});

test('questionnaireFor prefers the type row\'s decisions, then its questionnaire key, then the data file of its name', () => {
  const own = { key: 'escrow_row', name: 'Row decisions', closing: 'Done.', questions: [{ id: 'only', section: 'S', title: 'Only', question: 'Only?', location: 'here', basis: 'b', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] }] };
  const fromRow = questionnaireFor({ id: 't1', name: 'Escrow Agreement', questionnaire: 'rfp_federal_ppp', decisions: own });
  assert.equal(fromRow.key, 'escrow_row');
  assert.equal(startQuestionnaire(fromRow).pending.id, 'only');
  assert.equal(questionnaireFor({ id: 't1', name: 'Escrow Agreement', decisions: own }), fromRow, 'compiled once per content');
  assert.equal(questionnaireFor({ name: 'RFP Volume I', questionnaire: 'rfp_federal_ppp', decisions: null }), RFP);
  assert.equal(questionnaireFor({ name: 'Escrow Agreement' }).key, 'escrow');
  assert.equal(questionnaireFor({ name: 'Concept Note' }).key, 'memo', 'an alias of the research memo');
  assert.equal(questionnaireFor({ name: 'Non-Disclosure Agreement' }), null);
  assert.equal(questionnaireFor(null), null);
  // A non-RFP instruction names its own document and where a choice reaches.
  const escrow = questionnaireFor({ name: 'Escrow Agreement' });
  const q = escrow.questions.find((x) => x.id === 'arbitration_forum');
  const text = answerInstruction([{ question: q, optionIds: ['siac'] }], {}, escrow);
  assert.match(text, /^APPLY THIS DRAFTING DECISION TO THE ESCROW AGREEMENT\./);
  assert.match(text, /WHERE IT SITS IN THE ESCROW AGREEMENT: Article 8/);
  assert.match(text, /CHOSEN: Arbitration under the SIAC Rules, seated in Singapore/);
  assert.doesNotMatch(text, /RFP|Bidding Forms/);
});

// ---------------------------------------------------------------------------
// The completeness check: a letter

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const RPR = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr>';
const RPR_B = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="22"/></w:rPr>';
const LETTER_KINDS = {
  ref_line: { pPr: '<w:pPr><w:jc w:val="right"/></w:pPr>', rPr: RPR_B },
  dated_line: { pPr: '<w:pPr><w:spacing w:after="120"/><w:jc w:val="right"/></w:pPr>', rPr: RPR_B },
  to_line: { pPr: '<w:pPr><w:spacing w:after="0"/></w:pPr>', rPr: RPR },
  addressee: { pPr: '<w:pPr><w:spacing w:after="0"/><w:ind w:left="0"/></w:pPr>', rPr: RPR_B },
  subject_line: { pPr: '<w:pPr><w:ind w:left="1440" w:hanging="1440"/></w:pPr>', rPr: RPR_B },
  opening: { pPr: '<w:pPr><w:jc w:val="both"/></w:pPr>', rPr: RPR },
  body: { pPr: '<w:pPr><w:ind w:firstLine="720"/><w:jc w:val="both"/></w:pPr>', rPr: RPR },
  signature_for: { pPr: '<w:pPr><w:spacing w:before="480"/></w:pPr>', rPr: RPR },
  signatory_name: { pPr: '<w:pPr><w:pStyle w:val="List"/></w:pPr>', rPr: RPR_B },
};
const kindsList = { kinds: Object.fromEntries(Object.entries(LETTER_KINDS).map(([k, v]) => [k, { label: k, ...v }])) };
const letterPara = (kind, text) => `<w:p>${LETTER_KINDS[kind].pPr}<w:r>${LETTER_KINDS[kind].rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const docx = (body) => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
  'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`),
  'word/styles.xml': strToU8(`<w:styles ${NS}><w:style w:type="paragraph" w:styleId="List"><w:name w:val="List"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/></w:rPr></w:style></w:styles>`),
});
const LETTER = [
  ['ref_line', 'Ref: ABC-2026-001'],
  ['dated_line', 'Dated: October 20, 2026'],
  ['to_line', 'To,'],
  ['addressee', 'The Project Director'],
  ['subject_line', 'Subject: Extension Of The Scheduled Completion Date'],
  ['opening', 'We, [●] (the Concessionaire), refer you to the following:'],
  ['body', 'The Concessionaire requests an extension of thirty (30) days.'],
  ['signature_for', 'For And On Behalf Of'],
  ['signatory_name', '[●]'],
];

test('a letter with every fixed part passes; without its Subject line it is stopped until the lawyer confirms', () => {
  const skeleton = SKELETONS.letters;
  const answers = { reference: { optionIds: ['yes'] }, salutation: { optionIds: ['none'] }, reservation_of_rights: { optionIds: ['none'] } };
  const full = checkSkeleton({ bytes: docx(LETTER.map(([k, t]) => letterPara(k, t)).join('')), skeleton, kinds: kindsList, answers });
  assert.equal(full.status, 'complete', full.findings.join(' | '));
  assert.deepEqual(full.present.map((p) => p.id), ['ref', 'dated', 'to', 'addressee', 'subject', 'body', 'signature', 'signatory']);

  const noSubject = docx(LETTER.filter(([k]) => k !== 'subject_line').map(([k, t]) => letterPara(k, t)).join(''));
  const r = checkSkeleton({ bytes: noSubject, skeleton, kinds: kindsList, answers });
  assert.equal(r.status, 'blocked');
  assert.equal(r.blocking, true);
  assert.deepEqual(r.missing.map((m) => m.id), ['subject']);
  assert.equal(r.missing[0].sentence, 'The Subject line is missing.');
  assert.match(r.summary, /^Clause list: not filed — 1 of the firm's required parts is missing \(Subject line\)\. Add it, or confirm the omission\.$/);

  const confirmed = checkSkeleton({ bytes: noSubject, skeleton, kinds: kindsList, answers, confirmedOmissions: ['subject'] });
  assert.equal(confirmed.blocking, false);
  assert.deepEqual(confirmed.confirmed, ['subject']);
  assert.equal(confirmed.status, 'complete');
});

test('a letter\'s fixed parts are found by their kind even when the words do not say what they are, and a body-less letter is caught', () => {
  const skeleton = SKELETONS.letters;
  // The addressee has no words to know it by: its kind finds it. Remove it and the body.
  const paras = LETTER.filter(([k]) => !['addressee', 'opening', 'body'].includes(k));
  const r = checkSkeleton({ bytes: docx(paras.map(([k, t]) => letterPara(k, t)).join('')), skeleton, kinds: kindsList });
  assert.deepEqual(r.missing.map((m) => m.id), ['addressee', 'body']);
  assert.ok(r.decisionOpen.some((d) => d.id === 'salutation'), 'an unanswered salutation is mentioned, not required');
  // Read without the pack's kinds, a part known only by its kind is unchecked, not missing.
  const plain = checkSkeleton({ paragraphs: paras.map(([, t]) => ({ text: t })), skeleton });
  assert.deepEqual(plain.unchecked.sort(), ['addressee', 'signatory'].sort());
  assert.ok(!plain.missing.some((m) => m.id === 'addressee'));
});

test('a letter part out of the firm\'s order is reported, and does not block', () => {
  const order = [LETTER[0], LETTER[1], LETTER[4], LETTER[2], LETTER[3], ...LETTER.slice(5)];
  const r = checkSkeleton({ bytes: docx(order.map(([k, t]) => letterPara(k, t)).join('')), skeleton: SKELETONS.letters, kinds: kindsList });
  assert.equal(r.blocking, false);
  assert.equal(r.outOfOrder.length, 1);
  assert.match(r.outOfOrder[0].sentence, /^The Subject line is out of the firm's order: it belongs after /);
});

// ---------------------------------------------------------------------------
// The completeness check: an agreement

const AGREEMENT = {
  key: 'test-agreement', typeName: 'Test Agreement', completeLevels: [1],
  items: [
    { id: 'definitions', heading: 'Definitions & Interpretation', level: 1, presence: 'always', match: 'heading' },
    { id: 'appointment', heading: 'Appointment', level: 1, presence: 'always', match: 'heading' },
    { id: 'step_in', heading: 'Step-In Rights', level: 1, presence: 'optional', match: 'heading', not_used_form: 'Not Used' },
    { id: 'governing_law', heading: 'Governing Law', level: 1, presence: 'always', match: 'heading', synonyms: ['Governing Law And Dispute Resolution'] },
    { id: 'miscellaneous', heading: 'Miscellaneous', level: 1, presence: 'always', match: 'heading' },
    { id: 'schedule_notices', heading: 'Schedule A – Notices', level: 1, presence: 'always', match: 'heading', synonyms: ['Schedule [●] – Notices'], scan: false },
  ],
};
const h = (text) => ({ text, level: 1 });
const p = (text) => ({ text });

test('an agreement without Governing Law is stopped; an extra heading is reported as a new clause; "Not Used" stands for an optional article', () => {
  const paragraphs = [
    p('This Agreement is made on [●].'),
    h('1. Definitions & Interpretation'), p('In this Agreement …'),
    h('Appointment'), p('The Client appoints the Agent.'),
    h('Not Used'),
    h('Sanctions'), p('Each Party shall comply with applicable sanctions.'),
    h('Miscellaneous'), p('This Agreement may be signed in counterparts.'),
    h('Schedule C – Notices'), p('Party A: [●]'),
  ];
  const r = checkSkeleton({ paragraphs, skeleton: AGREEMENT });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.missing.map((m) => m.sentence), ['Governing Law is missing.']);
  assert.deepEqual(r.notUsed, ['step_in'], 'the Not Used heading in its place stands for the optional article');
  assert.deepEqual(r.optionalUnmarked, []);
  assert.deepEqual(r.newClauses.map((n) => n.heading), ['Sanctions']);
  assert.match(r.newClauses[0].sentence, /^"Sanctions" is not one of the firm's clauses for this document: it needs the AKLA comment "New clause — not in the firm's precedents: <why>"\.$/);
  assert.ok(r.present.some((x) => x.id === 'schedule_notices'), 'the schedule letter may change: [●] matches it');

  // With Governing Law (under its longer name), and the step-in article left out unmarked.
  const fixed = [...paragraphs.filter((x) => x.text !== 'Not Used')];
  fixed.splice(fixed.findIndex((x) => x.text === 'Miscellaneous'), 0, h('Governing Law And Dispute Resolution'), p('Pakistan law governs.'));
  const r2 = checkSkeleton({ paragraphs: fixed, skeleton: AGREEMENT });
  assert.equal(r2.blocking, false);
  assert.deepEqual(r2.optionalUnmarked.map((x) => x.sentence), ['Step-In Rights is neither in the draft nor marked "Not Used".']);
  assert.equal(r2.status, 'incomplete');
});

test('a heading tolerates numbers, "&" and [●]; a list item that merely names a clause is not the clause', () => {
  assert.equal(normaliseHeading('17. Revenue Matters'), 'revenue matters');
  assert.equal(normaliseHeading('Article 5 – Governing Law & Dispute Resolution'), 'governing law and dispute resolution');
  assert.equal(normaliseHeading('Schedule A - Notices'), 'schedule a notices');
  const skeleton = { completeLevels: [1], items: [
    { id: 'fm', heading: 'Force Majeure', level: 1, presence: 'always', match: 'heading' },
    { id: 'cil', heading: 'Change in Law', level: 1, presence: 'always', match: 'heading' },
    { id: 'parties', heading: 'Addresses – Party [●]', level: 1, presence: 'always', match: 'heading' },
  ] };
  const r = checkSkeleton({ paragraphs: [h('Force Majeure'), p('Change in Law.'), p('[●]'), h('Addresses – Party B')], skeleton });
  assert.deepEqual(r.missing.map((m) => m.id), ['cil'], 'the list item "Change in Law." is not the article; a bare [●] matches no heading');
  assert.ok(r.present.some((x) => x.id === 'parties'));
});

test('the real escrow list: a draft with every part passes, without Governing Law it is stopped, and the step-in decision is honoured', () => {
  const s = SKELETONS.escrow;
  const build = (skip = []) => itemsOf(s).filter((it) => !skip.includes(it.id)).flatMap((it) => [{ text: it.heading.replace('[●]', 'A'), level: it.level || null }, p('Text.')]);
  const answers = { government_funding: { optionIds: ['funded'] }, step_in: { optionIds: ['include'] } };
  assert.equal(checkSkeleton({ paragraphs: build(), skeleton: s, answers }).status, 'complete');
  const r = checkSkeleton({ paragraphs: build(['governing_law']), skeleton: s, answers });
  assert.deepEqual(r.missing.map((m) => m.sentence), ['Governing Law is missing.']);
  // Step-in answered "not used" and the article written all the same: reported, not blocking.
  const r2 = checkSkeleton({ paragraphs: build(), skeleton: s, answers: { ...answers, step_in: { optionIds: ['not_used'] } } });
  assert.equal(r2.blocking, false);
  assert.match(r2.unexpected[0].sentence, /^Step-In, Substitution & Concession Direct Agreement Coordination is in the draft, but the answer to the drafting decision leaves it out/);
  // Unanswered: the Government's accounts article left out is mentioned with its decision.
  const r3 = checkSkeleton({ paragraphs: build(['government_funding_accounts', 'mrg_funding_account', 'mrg_funding_amount', 'payment_of_mrg_contribution_amount', 'encashment_proceeds']), skeleton: s });
  assert.ok(r3.decisionOpen.some((d) => d.id === 'government_funding_accounts' && /government_funding/.test(d.sentence)));
});

test('the Concession Agreement list flags the master\'s missing Change in Law until the decision is answered', () => {
  const s = SKELETONS['concession-agreement'];
  const draft = itemsOf(s).filter((it) => it.id !== 'change_in_law').flatMap((it) => [{ text: it.heading, level: it.level || null }, p('Text.')]);
  const open = checkSkeleton({ paragraphs: draft, skeleton: s });
  const cil = open.decisionOpen.find((d) => d.id === 'change_in_law');
  assert.match(cil.sentence, /known gap|no Change in Law article/);
  const asked = checkSkeleton({ paragraphs: draft, skeleton: s, answers: { change_in_law: { optionIds: ['include'] } } });
  assert.deepEqual(asked.missing.map((m) => m.id), ['change_in_law']);
  // Tolling Matters is Article 17 under its other name.
  const tolling = draft.map((x) => (x.text === 'Revenue Matters' ? { ...x, text: 'Tolling Matters' } : x));
  assert.ok(checkSkeleton({ paragraphs: tolling, skeleton: s }).present.some((x) => x.id === 'article_17'));
});

test('documentParagraphs reads kinds, headings and bold from the Word file', () => {
  const bytes = docx(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Termination</w:t></w:r></w:p>${letterPara('subject_line', 'Subject: X')}`);
  const [head, subject] = documentParagraphs(bytes, { kinds: kindsList });
  assert.equal(head.styleLevel, 1);
  assert.equal(head.bold, true, 'bold from the style');
  assert.deepEqual(subject.kinds, ['subject_line']);
  assert.equal(subject.bold, true);
});

// ---------------------------------------------------------------------------
// The new-clause rule

test('newClauseFindings gives each new clause the firm\'s comment', () => {
  const r = checkSkeleton({ paragraphs: [h('Definitions & Interpretation'), h('Appointment'), h('Sanctions'), h('Governing Law'), h('Miscellaneous'), h('Schedule A – Notices')], skeleton: AGREEMENT });
  const f = newClauseFindings(r);
  assert.equal(f.length, 1);
  assert.equal(f[0].heading, 'Sanctions');
  assert.equal(f[0].paragraph, 3);
  assert.ok(f[0].comment.startsWith(NEW_CLAUSE_PREFIX));
  assert.equal(NEW_CLAUSE_PREFIX, NEW_CLAUSE_COMMENT.replace(' <why>', ''));
  assert.equal(newClauseComment('X', 'the lender asked for it.'), 'New clause — not in the firm\'s precedents: the lender asked for it.');
});

test('a heading written in a turn that matches no clause and has no comment gets the comment on the paragraph it follows', () => {
  const skeleton = { ...AGREEMENT, headingKinds: { h1: 1, h2: 2 } };
  const write = { op: 'write', after: 40, expected: 'Each Party shall act in good faith.', blocks: [{ kind: 'h1', text: 'Sanctions' }, { kind: 'body', text: 'Each Party shall comply with sanctions.' }] };
  const found = uncommentedNewClauses({ ops: [write], skeleton });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].op, { op: 'comment', p: 40, expected: 'Each Party shall act in good faith.', text: newClauseComment('Sanctions') });

  // Already commented on the anchor: nothing to add.
  const commented = [write, { op: 'comment', p: 40, expected: write.expected, text: `${NEW_CLAUSE_PREFIX} the lender requires a sanctions clause.` }];
  assert.deepEqual(uncommentedNewClauses({ ops: commented, skeleton }), []);
  // A firm clause written back in, a "Not Used" heading and a body block are not new.
  assert.deepEqual(uncommentedNewClauses({ ops: [{ op: 'write', after: 9, expected: 'x', blocks: [{ kind: 'h1', text: 'Governing Law' }, { kind: 'h1', text: 'Not Used' }, { kind: 'body', text: 'Sanctions' }] }], skeleton }), []);
  // An insert_after heading ("# …") counts too; a level the list does not cover in full does not.
  assert.equal(uncommentedNewClauses({ ops: [{ op: 'insert_after', p: 7, expected: 'y', text: '# Anti-Bribery' }], skeleton }).length, 1);
  assert.deepEqual(uncommentedNewClauses({ ops: [{ op: 'insert_after', p: 7, expected: 'y', text: '## Anti-Bribery' }], skeleton }), []);
});

test('skeletonFor prefers the row, then the file of the type\'s name; skeletonText lists the parts for a prompt', () => {
  assert.equal(skeletonFor({ name: 'Escrow Agreement' }).key, 'escrow');
  assert.equal(skeletonFor({ name: 'escrow agreement', skeleton: AGREEMENT }).key, 'test-agreement');
  assert.equal(skeletonFor({ name: 'Concept Note' }).key, 'memo');
  assert.equal(skeletonFor({ name: 'Unknown' }), null);
  const text = skeletonText(SKELETONS.escrow);
  assert.match(text, /^THE FIRM'S CLAUSE LIST for this document, in order/);
  assert.match(text, /- Governing Law & Dispute Resolution \(always\)/);
  assert.match(text, /Step-In, Substitution & Concession Direct Agreement Coordination \(depends on decision step_in, else "Not Used"\)/);
  assert.ok(text.length < 6000);
});

// ---------------------------------------------------------------------------
// The seed script

function stubDb(rows) {
  const writes = [];
  return {
    writes,
    from(table) {
      assert.equal(table, 'document_types');
      return {
        select: async () => ({ data: rows.map((r) => ({ ...r })), error: null }),
        update(values) {
          return { eq: async (col, id) => { writes.push({ id, values }); const row = rows.find((r) => r[col] === id); Object.assign(row, values); return { error: null }; } };
        },
      };
    },
  };
}

test('seed_skeletons writes each file into its type\'s row by name, finds the RFP by its questionnaire key, and changes nothing on a second run', async () => {
  assert.deepEqual(plan().filter((x) => x.problems.length), [], 'every file checks out');
  assert.deepEqual(seedArgs(['--dry-run', '--only', 'escrow,letters']), { dryRun: true, only: ['escrow', 'letters'], help: false });
  const rows = [
    { id: 't-escrow', name: 'Escrow Agreement', questionnaire: null, skeleton: null, decisions: null },
    { id: 't-letter', name: 'Letter / Notice', questionnaire: null, skeleton: null, decisions: null },
    { id: 't-rfp', name: 'RFP Volume I', questionnaire: 'rfp_federal_ppp', skeleton: null, decisions: null },
  ];
  const db = stubDb(rows);
  const dry = await seedSkeletons({ supabase: db, dryRun: true, only: ['escrow', 'rfp', 'memo'] });
  assert.deepEqual(dry.map((r) => [r.key, r.action]), [['escrow', 'would write'], ['memo', 'skipped'], ['rfp', 'would write']]);
  assert.equal(db.writes.length, 0);
  const first = await seedSkeletons({ supabase: db, only: ['escrow', 'letters', 'rfp'] });
  assert.deepEqual(first.map((r) => [r.key, r.type, r.action]), [['escrow', 'Escrow Agreement', 'written'], ['letters', 'Letter / Notice', 'written'], ['rfp', 'RFP Volume I', 'written']]);
  assert.equal(db.writes.find((w) => w.id === 't-rfp').values.decisions.key, 'rfp_federal_ppp');
  assert.equal(db.writes.find((w) => w.id === 't-escrow').values.skeleton.key, 'escrow');
  const again = await seedSkeletons({ supabase: db, only: ['escrow', 'letters', 'rfp'] });
  assert.ok(again.every((r) => r.action === 'unchanged'));
  assert.equal(db.writes.length, 3);
  // A file with a problem is refused and nothing of it is written.
  const broken = await seedSkeletons({ supabase: db, skeletons: { escrow: { ...SKELETONS.escrow, items: [...SKELETONS.escrow.items, SKELETONS.escrow.items[0]] } }, decisions: DECISIONS });
  assert.equal(broken[0].action, 'refused');
  assert.match(broken[0].note, /id is used twice/);
});
