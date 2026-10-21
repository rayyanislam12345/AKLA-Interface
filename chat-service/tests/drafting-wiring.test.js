// Slices 3 and 4 wired into a Word turn (draftChecks.js; server.js, the
// connector's fill and mark-up tools): the style sheet, clause list,
// decisions and the firm's clauses in the draft prompt (the clauses skipped
// before the clause bank's migration); a missing "always" part refused the
// way the format gate refuses, and filed once the omission is confirmed; a
// new clause given its comment; wording comments only on what the turn
// wrote, never on the pack's untouched words; the RFP's questionnaire from
// questionnaireFor with the same questions; change cards for the four block
// operations, decided both ways; deploy.sh shipping everything the
// services import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { inspectDocx, applyDocxOps, acceptChangesBy } from '../docxAgent.js';
import { editRecords, recordedResults, cardsFor, applyDecisions, findRevisions, countsWith } from '../changes.js';
import { storeUnlessRefused } from '../formatFingerprint.js';
import { styleSheetText } from '../firmRules.js';
import { skeletonFor, skeletonText, NEW_CLAUSE_PREFIX } from '../skeletonCheck.js';
import { QUESTIONNAIRES, questionnaireFor } from '../questionnaire.js';
import { decisionFiles } from '../decisions.js';
import { NEEDS_MIGRATION, headingNorm } from '../clauseBank.js';
import {
  draftingOf, draftingPromptText, decisionsPromptText, examplesHeadings, clauseExamplesBlock, autoCommentOps, wordingCommentOps,
  skeletonGate, draftGate, omissionsConfirmedIn, moreWordingText, connectorConfirmSentence, MAX_WORDING_COMMENTS, MAX_EXAMPLES_CHARS,
} from '../draftChecks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '..');

// ---------------------------------------------------------------------------
// A small agreement: headings in Heading 1, numbered body paragraphs, a
// table, a footnote, a signature line. The kinds list is read off it.

const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const ARIAL = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>';
const STYLES = `<w:styles ${ns}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>`
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/></w:style>'
  + '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>';
const NUMBERING = `<w:numbering ${ns}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading1"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
const RUN = `<w:rPr>${ARIAL}<w:sz w:val="22"/></w:rPr>`;
const H1_PPR = '<w:pPr><w:pStyle w:val="Heading1"/><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr>';
const H1_RPR = `<w:rPr>${ARIAL}<w:b/><w:caps/><w:sz w:val="22"/></w:rPr>`;
const BODY_PPR = '<w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="120"/><w:jc w:val="both"/></w:pPr>';
const PLAIN_PPR = '<w:pPr><w:spacing w:after="120"/><w:jc w:val="both"/></w:pPr>';
const FN_PPR = '<w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>';
const FN_RPR = `<w:rPr>${ARIAL}<w:sz w:val="18"/></w:rPr>`;
const REF_RPR = `<w:rPr><w:rStyle w:val="FootnoteReference"/>${ARIAL}</w:rPr>`;
const CELL = (text, head = false) => `<w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="1F3864"/>' : ''}</w:tcPr><w:p ${pid()}><w:pPr><w:spacing w:after="60"/></w:pPr><w:r><w:rPr>${ARIAL}${head ? '<w:b/>' : ''}<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
let nextId = 0x300;
const pid = () => `w14:paraId="${(nextId++).toString(16).toUpperCase().padStart(8, '0')}" w14:textId="77777777"`;
const run = (text, rPr = RUN) => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (pPr, inner) => `<w:p ${pid()}>${pPr}${inner}</w:p>`;
const h1 = (text) => para(H1_PPR, run(text, H1_RPR));
const body = (text, extra = '') => para(BODY_PPR, run(text) + extra);
const plain = (text) => para(PLAIN_PPR, run(text));
const TABLE = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>`
  + `<w:tr ${pid()}><w:trPr><w:tblHeader/></w:trPr>${CELL('Issue', true)}${CELL('Comment', true)}</w:tr><w:tr ${pid()}>${CELL('Title')}${CELL('Clear')}</w:tr></w:tbl>`;
const P = {
  defs: 'In this Agreement the Parties shall organize their affairs.',
  appoint: 'The Company appoints the Agent on [●] terms.',
  law: 'This Agreement is governed by the laws of Pakistan.',
  misc: 'Each Party shall act in good faith.',
  signed: 'Signed for the Company.',
};
const BODY = h1('Definitions and Interpretation') + body(P.defs, `<w:r>${REF_RPR}<w:footnoteReference w:id="1"/></w:r>`)
  + h1('Appointment') + body(P.appoint) + TABLE
  + h1('Governing Law') + body(P.law)
  + h1('Miscellaneous') + body(P.misc)
  + plain(P.signed);
const FOOTNOTES = `<w:footnotes ${ns}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`
  + `<w:footnote w:id="1"><w:p ${pid()}>${FN_PPR}<w:r>${REF_RPR}<w:footnoteRef/></w:r><w:r>${FN_RPR}<w:t xml:space="preserve"> </w:t></w:r><w:r>${FN_RPR}<w:t>Section 2 of the Act.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
const docx = (bodyXml = BODY) => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>'),
  'word/_rels/document.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>'),
  'word/document.xml': strToU8(`<w:document ${ns}><w:body>${bodyXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`),
  'word/styles.xml': strToU8(STYLES), 'word/numbering.xml': strToU8(NUMBERING), 'word/footnotes.xml': strToU8(FOOTNOTES),
});
const DOC = docx();
const part = (bytes, name = 'word/document.xml') => { const e = unzipSync(bytes)[name]; return e ? strFromU8(e) : null; };
const PARAGRAPH = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const visible = (bytes) => (part(bytes).match(PARAGRAPH) ?? []).map((p) => [...p.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).filter((t) => t.trim());
const exampleOf = (text) => {
  const p = (part(DOC).match(PARAGRAPH) ?? []).find((x) => x.includes(`>${text}</w:t>`));
  return { pPr: /^<w:p(?:\s[^>]*)?>(<w:pPr>[\s\S]*?<\/w:pPr>)/.exec(p)[1], rPr: /<w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)<w:t/.exec(p)[1] };
};
const KINDS = {
  kinds: {
    h1: { ...exampleOf('Appointment'), styleId: 'Heading1', numId: null, ilvl: null, label: 'heading' },
    body: { ...exampleOf(P.appoint), styleId: null, numId: '1', ilvl: '1', label: 'numbered paragraph' },
    plain: { ...exampleOf(P.signed), styleId: null, numId: null, ilvl: null, label: 'plain paragraph' },
  },
  tables: {},
  footnote: { pPr: FN_PPR, rPr: FN_RPR, refRPr: REF_RPR },
};
const SKELETON = {
  key: 'test-agreement', typeName: 'Test Agreement', completeLevels: [1], headingKinds: { h1: 1 },
  items: [
    { id: 'definitions', heading: 'Definitions & Interpretation', level: 1, presence: 'always', match: 'heading' },
    { id: 'appointment', heading: 'Appointment', level: 1, presence: 'always', match: 'heading' },
    { id: 'governing_law', heading: 'Governing Law', level: 1, presence: 'always', match: 'heading', synonyms: ['Applicable Law'] },
    { id: 'miscellaneous', heading: 'Miscellaneous', level: 1, presence: 'always', match: 'heading' },
  ],
};

// Operations name paragraphs by their words; the listing's numbers go in their place.
const VIEW = inspectDocx(DOC);
const no = (text) => { const hit = [...VIEW.byRef].find(([, r]) => r.exactText === text); assert.ok(hit, `no paragraph "${text}"`); return hit[0]; };
const apply = (ops) => applyDocxOps(DOC, ops, VIEW.byRef, { kinds: KINDS });
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const commentsOf = (bytes) => [...(part(bytes, 'word/comments.xml') ?? '').matchAll(/<w:comment\b[\s\S]*?<\/w:comment>/g)].map((m) => unescape([...m[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((x) => x[1]).join('')));

// ---------------------------------------------------------------------------
// The prompt

test('a draft prompt carries the style sheet, the clause list in order and the decisions for its kind of document', () => {
  const type = { id: 't-escrow', name: 'Escrow Agreement' };
  const d = draftingOf(type);
  assert.equal(d.styleKey, 'escrow');
  assert.equal(d.skeleton.key, 'escrow');
  assert.equal(d.questionnaire.key, 'escrow');
  const text = draftingPromptText({ typeName: type.name, skeleton: d.skeleton, questionnaire: d.questionnaire });
  assert.ok(text.startsWith(styleSheetText('Escrow Agreement')), 'the style sheet first');
  assert.ok(text.includes(skeletonText(d.skeleton)), 'then the clause list with always / optional / decision');
  assert.match(text, /- Governing Law \(always\)/);
  assert.match(text, /THE FIRM'S DRAFTING DECISIONS for this document \(4\)\. [^\n]*never given a default \(an arbitration forum least of all\)/);
  assert.match(decisionsPromptText(d.questionnaire), /\n- [^\n]*arbitration[^\n]*\(/i);
  // A kind with no sheet or list of its own: the firm-wide rules alone.
  const plainType = draftingOf({ id: 'x', name: 'Share Purchase Agreement' });
  assert.equal(plainType.skeleton, null);
  assert.equal(draftingPromptText({ typeName: 'Share Purchase Agreement' }), styleSheetText(null));
  // The Hub's fill turn puts it beside the pack's block, examples after it.
  const server = readFileSync(join(SERVICE, 'server.js'), 'utf8');
  assert.ok(server.includes('draftingBlock = `\\n\\n${draftingPromptText({ typeName: drafting.typeName, skeleton: drafting.skeleton, questionnaire: drafting.questionnaire })}${examples.text ? `\\n\\n${examples.text}` : ""}`;'));
  assert.ok(server.includes('${packBlock}${draftingBlock}${earlierText}'));
});

test('the firm\'s clauses: the headings named and the parts not yet there, read without an embedding; none before the migration, never over the cap', async () => {
  const escrow = skeletonFor({ name: 'Escrow Agreement' });
  assert.deepEqual(examplesHeadings({ skeleton: escrow, message: 'add a governing law clause and tidy the miscellaneous article' }).map(headingNorm).sort(), ['governing law', 'miscellaneous'], 'the clause bank is asked by each item\'s examples heading');
  // A document without Governing Law and Miscellaneous: those, after what the message names.
  const lacking = docx(h1('Definitions and Interpretation') + body(P.defs) + h1('Appointment') + body(P.appoint));
  assert.deepEqual(examplesHeadings({ skeleton: SKELETON, bytes: lacking, message: 'please draft the appointment clause' }), ['Appointment', 'Governing Law', 'Miscellaneous']);
  assert.equal(examplesHeadings({ skeleton: escrow, message: 'x'.repeat(10) }).length, 0, 'nothing named and no file: nothing fetched');
  assert.ok(examplesHeadings({ skeleton: escrow, bytes: lacking }).length <= 6);

  // Before the clause bank's migration: no block, the turn goes on.
  const missing = { from: () => { const q = { select: () => q, eq: () => q, in: () => q, ilike: () => q, order: () => q, limit: () => q, then: (ok) => Promise.resolve({ data: null, error: { message: 'column precedent_passages.heading_norm does not exist' } }).then(ok) }; return q; } };
  const none = await clauseExamplesBlock({ supabase: missing, typeId: 't', typeName: 'Escrow Agreement', headings: ['Governing Law'] });
  assert.equal(none.text, '');
  assert.match(none.skipped, /migration/);
  assert.equal(NEEDS_MIGRATION.includes('20261021090000_clause_bank.sql'), true);
  // Any other failure is skipped too.
  const broken = { from: () => { throw new Error('network down'); } };
  assert.equal((await clauseExamplesBlock({ supabase: broken, typeId: 't', headings: ['Governing Law'] })).text, '');

  // With the bank: each heading's firm versions, the block capped.
  const long = 'The Parties shall comply with the laws of Pakistan in every respect. '.repeat(40);
  const rows = (heading) => Array.from({ length: 4 }, (_, i) => ({ id: `${heading}${i}`, document_id: `d${i}`, storage_path: `p/${i}.docx`, filename: `Precedent ${i}.docx`, document_type_id: 't', chunk_index: 0, ordinal: 1, body: long, heading, heading_norm: headingNorm(heading), clause_no: '14', family: 'escrow' }));
  const bank = {
    from: () => {
      let want = null;
      const q = { select: () => q, eq: (col, v) => { if (col === 'heading_norm') want = v; return q; }, in: () => q, ilike: () => q, order: () => q, limit: () => q,
        then: (ok) => Promise.resolve({ data: want ? rows(want) : [], error: null }).then(ok) };
      return q;
    },
  };
  const headings = ['Governing Law', 'Notices', 'Force Majeure', 'Termination', 'Confidentiality', 'Assignment'];
  const block = await clauseExamplesBlock({ supabase: bank, typeId: 't', typeName: 'Escrow Agreement', headings });
  assert.ok(block.text.startsWith('THE FIRM\'S OWN VERSIONS OF “Governing Law”'));
  assert.ok(block.text.length <= MAX_EXAMPLES_CHARS, `${block.text.length} chars`);
  assert.ok(block.headings.length >= 1 && block.headings.length < headings.length, 'cut at the cap, not every heading');
  assert.match(block.text, /In your reply, name the precedent you followed\./);
});

// ---------------------------------------------------------------------------
// The clause list before filing

test('a missing "always" part is refused as the format gate refuses, nothing stored; a confirmed omission files', async () => {
  // An edit that takes Governing Law out (heading and clause).
  const out = await apply([{ op: 'remove_block', from: no('Governing Law'), to: no(P.law), expected: 'Governing Law' }]);
  assert.equal(out.applied, 1);
  const refused = skeletonGate({ bytes: out.bytes, baseBytes: DOC, skeleton: SKELETON, kinds: KINDS, ops: [] });
  assert.equal(refused.refused, true);
  assert.deepEqual(refused.record.blocking, ['governing_law']);
  assert.equal(refused.text, 'Not filed: the firm\'s Test Agreement always has this part, and this change would take it out:\n- Governing Law is missing.\nNothing was saved. Ask me to add it, or confirm the omission by replying "leave out Governing Law" — or "confirm omission: governing_law" — and I will file the draft without it.');
  // Through the Hub's gate: nothing is stored, the reply is the refusal.
  const format = { refused: false, text: 'Format matches the firm\'s standard (TEST).', result: { status: 'matches' }, mode: 'enforce' };
  const gate = draftGate(format, refused, 'Wording: …');
  let stored = 0;
  const r = await storeUnlessRefused(gate, async () => { stored++; return { id: 'x' }; });
  assert.equal(stored, 0, 'no copy, no change rows');
  assert.equal(r.refused, true);
  assert.equal(r.appended, `\n\n${refused.text}`);
  assert.equal(gate.result.status, 'matches', 'the format record survives for the message');
  // The lawyer confirms, in so many words.
  assert.deepEqual(omissionsConfirmedIn('Yes, leave out the governing law clause.', SKELETON, ['governing_law']), ['governing_law']);
  assert.deepEqual(omissionsConfirmedIn('confirm omission: governing_law', SKELETON, ['governing_law']), ['governing_law']);
  assert.deepEqual(omissionsConfirmedIn('No, add it back please', SKELETON, ['governing_law']), [], 'putting it back confirms nothing');
  const filed = skeletonGate({ bytes: out.bytes, baseBytes: DOC, skeleton: SKELETON, kinds: KINDS, ops: [], confirmedOmissions: ['governing_law'] });
  assert.equal(filed.refused, false);
  assert.match(filed.line, /^Clause list: Left out as confirmed: Governing Law\./);
  const ok = draftGate(format, filed, 'Wording: what was written this turn follows the firm\'s style sheet.');
  assert.equal(ok.refused, false);
  assert.equal(ok.text, `Format matches the firm's standard (TEST).\n\n${filed.line}\n\nWording: what was written this turn follows the firm's style sheet.`);
  // claude.ai is told the ids to send back.
  const c = skeletonGate({ bytes: out.bytes, baseBytes: DOC, skeleton: SKELETON, ops: [], confirmHow: connectorConfirmSentence('apply_tracked_changes') });
  assert.match(c.text, /call apply_tracked_changes again with the same changes and confirmedOmissions: \["governing_law"\]\.$/);
});

test('a draft from a shell needs every part; a form or another\'s draft that never had one is reported, not refused', () => {
  const lacking = docx(h1('Definitions and Interpretation') + body(P.defs) + h1('Appointment') + body(P.appoint) + h1('Miscellaneous') + body(P.misc));
  const shell = skeletonGate({ bytes: lacking, baseBytes: lacking, skeleton: SKELETON, full: true, ops: [] });
  assert.equal(shell.refused, true, 'a shell fill must write it');
  const form = skeletonGate({ bytes: lacking, baseBytes: lacking, skeleton: SKELETON, full: false, report: true, ops: [] });
  assert.equal(form.refused, false);
  assert.match(form.line, /^Clause list: nothing this draft took out is missing; 1 point to look at:\n- Governing Law is missing \(the file it was drafted from does not have it either\)\.$/);
  const edit = skeletonGate({ bytes: lacking, baseBytes: lacking, skeleton: SKELETON, ops: [] });
  assert.equal(edit.refused, false);
  assert.equal(edit.line, '', 'an edit that changed nothing on the list says nothing');
  const complete = skeletonGate({ bytes: DOC, baseBytes: DOC, skeleton: SKELETON, full: true, ops: [] });
  assert.equal(complete.line, 'Clause list: every part the firm\'s Test Agreement expects is present, in the firm\'s order.');
});

test('a new clause written without its comment gets "New clause — not in the firm\'s precedents" on the paragraph it follows, and the reply lists it', async () => {
  const ops = [{ op: 'write', after: no(P.misc), expected: P.misc, blocks: [{ kind: 'h1', text: 'Sanctions' }, { kind: 'body', text: 'Each Party shall comply with all applicable sanctions.' }] }];
  const auto = autoCommentOps({ ops, skeleton: SKELETON, styleSheet: 'core' });
  assert.equal(auto.newClauses.length, 1);
  assert.equal(auto.newClauses[0].p, no(P.misc));
  const out = await apply([...ops, ...auto.ops]);
  assert.equal(out.results.filter((r) => r.status === 'applied').length, 1 + auto.ops.length);
  const notes = commentsOf(out.bytes);
  assert.ok(notes.some((t) => t.startsWith(`${NEW_CLAUSE_PREFIX} "Sanctions" was added on the lawyer's instruction`)), notes.join(' | '));
  const gate = skeletonGate({ bytes: out.bytes, baseBytes: DOC, skeleton: SKELETON, kinds: KINDS, ops, full: false, report: true });
  assert.equal(gate.refused, false);
  assert.match(gate.line, /- New clause, not in the firm's precedents \(it carries an AKLA comment saying so\): "Sanctions"\./);
  // Already commented by the reply: no second comment.
  const own = [...ops, { op: 'comment', p: no(P.misc), expected: P.misc, text: `${NEW_CLAUSE_PREFIX} the lenders require it.` }];
  assert.equal(autoCommentOps({ ops: own, skeleton: SKELETON }).newClauses.length, 0);
});

// ---------------------------------------------------------------------------
// The wording check, on what the turn wrote

test('wording comments land only on what the turn wrote: a written -ize word is flagged, the pack\'s own untouched -ize word is not', async () => {
  const ops = [
    // A fill into the clause: "30 days" and "organize" are the turn's words.
    { op: 'replace', p: no(P.appoint), expected: P.appoint, text: 'The Company appoints the Agent on 30 days notice and the Agent shall organize the handover.' },
    // A change to the definitions clause that leaves its own "organize" alone.
    { op: 'replace', p: no(P.defs), expected: P.defs, text: 'In this Agreement the Parties shall organize all of their affairs.' },
    // New paragraphs: their words are the turn's.
    { op: 'write', after: no(P.misc), expected: P.misc, blocks: [{ kind: 'body', text: 'The Agent shall utilize the Escrow Account only as set out herein.' }] },
  ];
  const auto = autoCommentOps({ ops, skeleton: SKELETON, styleSheet: 'escrow' });
  const notes = auto.wording.ops.map((o) => `${o.p}: ${o.text}`);
  assert.equal(auto.wording.result.total, 3, notes.join(' | '));
  assert.ok(notes.some((n) => n.startsWith(`${no(P.appoint)}: Wording (number or amount): Write it in words and figures: thirty (30) days.`)));
  assert.ok(notes.some((n) => n.startsWith(`${no(P.appoint)}: Wording (spelling): British spelling: “organise”, not “organize”.`)));
  assert.ok(notes.some((n) => n.startsWith(`${no(P.misc)}: Wording (spelling): British spelling: “utilise”, not “utilize”. In the paragraph added after this one:`)));
  assert.ok(!notes.some((n) => n.startsWith(`${no(P.defs)}:`)), 'the definitions clause\'s own -ize word is the pack\'s, not this turn\'s');
  // Applied in the same pass: the comments are in the file, on those paragraphs.
  const out = await apply([...ops, ...auto.ops]);
  const accepted = acceptChangesBy(out.bytes);
  const comments = commentsOf(accepted);
  assert.equal(comments.filter((t) => t.startsWith('Wording (')).length, 3);
  assert.ok(!comments.some((t) => t.includes('affairs')));
  // The pack's words alone, never written by the turn: nothing.
  assert.equal(wordingCommentOps({ ops: [{ op: 'delete', p: no(P.defs), expected: P.defs }], styleSheet: 'escrow' }).checked, 0);
  assert.equal(wordingCommentOps({ ops: [{ op: 'delete', p: no(P.defs), expected: P.defs }] }).line, '', 'no words written, no wording line');
  // The reply's line, and the cap with what was not commented on.
  assert.match(auto.wording.line, /^Wording: 3 points to look at against the firm's style sheet in what was written this turn \(1 number or amount, 2 spellings\); none stops the draft being filed\. Each is an AKLA comment\.$/);
  const many = Array.from({ length: MAX_WORDING_COMMENTS + 12 }, (_, i) => ({ op: 'insert_after', p: no(P.misc), expected: P.misc, text: `Payment ${i} is due within ${i + 2} days.` }));
  const capped = wordingCommentOps({ ops: many, styleSheet: 'escrow' });
  assert.equal(capped.ops.length, MAX_WORDING_COMMENTS);
  assert.match(capped.line, /…and 12 more wording points: ask to see them\.$/);
  assert.equal(capped.rest.length, 12);
  assert.match(moreWordingText(capped.rest), /^WORDING POINTS YOUR LAST CHANGE COUNTED BUT DID NOT COMMENT ON[\s\S]*\n- after ¶\d+: Write it in words and figures/);
  assert.match(wordingCommentOps({ ops: many, styleSheet: 'escrow', more: 'check_text lists them all' }).line, /…and 12 more wording points: check_text lists them all\.$/);
});

// ---------------------------------------------------------------------------
// The decisions

test('the RFP\'s questionnaire comes through questionnaireFor with the same questions, and the Hub uses it for the guide', () => {
  const legacy = QUESTIONNAIRES.rfp_federal_ppp;
  const byKey = questionnaireFor({ id: 'rfp', name: 'Request for Proposal (RFP)', questionnaire: 'rfp_federal_ppp' });
  assert.equal(byKey, legacy);
  const fromRow = questionnaireFor({ id: 'rfp', name: 'Request for Proposal (RFP)', questionnaire: 'rfp_federal_ppp', decisions: decisionFiles().rfp });
  assert.deepEqual(fromRow.questions.map((q) => [q.id, q.title, q.options.map((o) => o.id)]), legacy.questions.map((q) => [q.id, q.title, q.options.map((o) => o.id)]));
  const server = readFileSync(join(SERVICE, 'server.js'), 'utf8');
  assert.ok(!server.includes('QUESTIONNAIRES'), 'the code table is no longer read');
  assert.ok(server.includes('const guide = !standardising && skill?.key === "draft" && documentType?.questionnaire && hasWordStandard ? questionnaireFor(documentType) : null;'));
  assert.ok(server.includes('answerInstruction(guideTurn.decisions, guideState.answers, guide)'));
  assert.ok(server.includes('const guideState = guide && thread.questionnaire?.key ? thread.questionnaire : null;'), 'a state holding only confirmed omissions is not a guide');
  for (const f of ['standards.js', 'fillStandard.js']) assert.ok(!readFileSync(join(SERVICE, 'connector/tools', f), 'utf8').includes('QUESTIONNAIRES'), f);
});

test('the Hub records a confirmed omission on the thread and files the refused reply\'s changes again without a model call', () => {
  const server = readFileSync(join(SERVICE, 'server.js'), 'utf8');
  assert.ok(server.includes('const confirmed = omissionsConfirmedIn(message, drafting.skeleton, refusedOn.missing ?? []);'));
  assert.ok(server.includes('await supabase.from("ai_chat_threads").update({ questionnaire: state }).eq("id", threadId);'));
  assert.ok(server.includes('if (refusedOn.storagePath === docxBase.storagePath && Array.isArray(refusedOn.ops) && refusedOn.ops.length) skeletonRetry = { ops: refusedOn.ops, confirmed };'));
  assert.ok(server.includes('if (clauses?.refused) metadata.skeletonRefused = { storagePath: docxBase.storagePath, missing: clauses.record.blocking,'));
  assert.ok(server.includes('? retryReply(skeletonRetry, drafting.skeleton, send)'));
  // The gate the store runs behind is the format check and the clause list together.
  const gate = server.indexOf('const gate = draftGate(format, clauses, auto?.wording.line ?? "");');
  assert.ok(gate > 0 && gate < server.indexOf('const gated = await storeUnlessRefused(gate, async () => {'));
  assert.ok(server.indexOf('const clauses = out.applied > 0 && drafting?.skeleton ? skeletonGate({') > server.indexOf('if (fillIn && out.applied > 0) out.bytes = acceptChangesBy(out.bytes);'), 'checked on the accepted file');
});

// ---------------------------------------------------------------------------
// Change cards for the block operations

test('write, repeat_block, add_row and remove_block each make one change card, decided both ways in the file', async () => {
  const ops = [
    { op: 'write', after: no(P.misc), expected: P.misc, blocks: [{ kind: 'h1', text: 'Confidentiality' }, { kind: 'body', text: 'Each Party shall keep this Agreement confidential.' }, { kind: 'footnote', text: 'Section 9 of the Act.' }] },
    { op: 'repeat_block', from: no(P.signed), to: no(P.signed), after: no(P.signed), expected: P.signed },
    { op: 'add_row', like_row: no('Title'), expected: 'Title', cells: ['Consents', 'Pending'] },
    { op: 'remove_block', from: no('Governing Law'), to: no(P.law), expected: 'Governing Law', why: 'The lawyer asked for it to go.' },
  ];
  const out = await apply(ops);
  assert.equal(out.applied, 4, JSON.stringify(out.results.map((r) => [r.kind, r.status, r.reason])));
  const { rows } = editRecords(out.results, { threadId: 'th', rootId: 'root', userId: 'u' });
  assert.equal(recordedResults(out.results).length, rows.length);
  assert.deepEqual(rows.map((r) => r.op), ['insert_after', 'insert_after', 'insert_after', 'delete']);
  assert.ok(rows.every((r) => r.placement === 'placed' && r.status === 'pending' && r.revision_ids.length > 0));
  assert.equal(rows[0].suggested_text, 'Confidentiality\nEach Party shall keep this Agreement confidential.\nSection 9 of the Act.');
  assert.equal(rows[1].suggested_text, P.signed, 'the copy reads as what it copied');
  assert.equal(rows[2].suggested_text, 'Consents | Pending');
  assert.equal(rows[3].original_text, `Governing Law\n${P.law}`);
  assert.equal(rows[3].rationale, 'The lawyer asked for it to go.');
  assert.equal(rows[0].rationale, "Written in the firm's own paragraph kinds.");
  rows.forEach((r, i) => { r.id = `r${i}`; r.created_at = '2026-10-21T10:00:00Z'; });
  const cards = cardsFor(rows);
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.deepEqual(rows.map((r) => [byId[r.id].kind, byId[r.id].state, byId[r.id].canAccept, byId[r.id].canReject]), [
    ['addition', 'waiting', true, true], ['addition', 'waiting', true, true], ['addition', 'waiting', true, true], ['deletion', 'waiting', true, true],
  ]);
  assert.equal(byId.r3.before, `Governing Law\n${P.law}`);
  assert.equal(byId.r2.after, 'Consents | Pending');
  // Every AI revision in the file is on a card, the footnote's too.
  assert.equal(countsWith(rows, findRevisions(out.bytes)).unlisted, 0);
  const items = (decision) => rows.map((r) => ({ id: r.id, part: r.part, revisionIds: r.revision_ids, decision }));

  // Accept all: the new paragraphs, the copy, the row stay; Governing Law goes; no AI mark is left.
  const accepted = applyDecisions(out.bytes, items('accepted'));
  assert.deepEqual(accepted.results.map((r) => r.status), ['applied', 'applied', 'applied', 'applied']);
  const a = visible(accepted.bytes);
  assert.ok(a.includes('Confidentiality') && a.includes('Each Party shall keep this Agreement confidential.'));
  assert.equal(a.filter((t) => t === P.signed).length, 2);
  assert.ok(a.includes('Consents') && a.includes('Pending'));
  assert.ok(!a.includes('Governing Law') && !a.includes(P.law));
  assert.equal(findRevisions(accepted.bytes).ours.size, 0);
  assert.match(part(accepted.bytes, 'word/footnotes.xml'), /Section 9 of the Act\./);
  assert.equal((part(accepted.bytes).match(/<w:tr[\s>]/g) ?? []).length, 3, 'the new row is a row of the table');

  // Reject all: the document reads as it did, the new footnote gone with its paragraph.
  const rejected = applyDecisions(out.bytes, items('rejected'));
  assert.deepEqual(rejected.results.map((r) => r.status), ['applied', 'applied', 'applied', 'applied']);
  assert.deepEqual(visible(rejected.bytes), visible(DOC));
  assert.equal(findRevisions(rejected.bytes).ours.size, 0);
  assert.doesNotMatch(part(rejected.bytes, 'word/footnotes.xml'), /Section 9 of the Act\./);
  assert.equal((part(rejected.bytes).match(/<w:tr[\s>]/g) ?? []).length, 2);

  // One at a time: rejecting the row alone leaves the rest waiting and the table whole.
  const one = applyDecisions(out.bytes, [items('rejected')[2]]);
  assert.equal(one.results[0].status, 'applied');
  assert.ok(!visible(one.bytes).includes('Consents'));
  assert.ok(visible(one.bytes).includes('Confidentiality'), 'the write still waits');
});

// ---------------------------------------------------------------------------
// deploy.sh

test('deploy.sh ships every module the chat service, the index worker and the connector import, and the data folders they read', () => {
  const deploy = readFileSync(join(SERVICE, 'deploy.sh'), 'utf8');
  const scp = /scp -i "\$KEY" (server\.js[^\n]*?) "\$STAMP" "\$HOST:\/tmp\/"/.exec(deploy)[1].split(/\s+/).filter((f) => f.endsWith('.js'));
  const moved = /sudo mv ((?:\/tmp\/[\w.]+\.js ?)+)/.exec(deploy)[1].trim().split(/\s+/).map((f) => f.replace('/tmp/', ''));
  const owned = [...deploy.matchAll(/\$DEST\/([\w]+\.js)/g)].map((m) => m[1]);
  for (const f of ['clauseBank.js', 'decisions.js', 'skeletonCheck.js', 'draftChecks.js']) {
    assert.ok(scp.includes(f) && moved.includes(f) && owned.includes(f), `${f} in the scp, mv and chown lists`);
  }
  const folders = /for d in ([\w ]+); do/.exec(deploy)[1].split(' ');
  assert.deepEqual(folders.sort(), ['decisions', 'skeletons', 'styleSheets']);
  // Every relative import, from every entry point, resolved and walked.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const target = join(dirname(file), m[1] ?? m[2]);
      assert.ok(existsSync(target), `${relative(SERVICE, file)} imports ${m[1] ?? m[2]}, which does not exist`);
      walk(target);
    }
  };
  const tools = readdirSync(join(SERVICE, 'connector/tools')).filter((f) => f.endsWith('.js')).map((f) => join(SERVICE, 'connector/tools', f));
  for (const entry of [join(SERVICE, 'server.js'), join(SERVICE, 'connector/connector.js'), join(SERVICE, 'indexWorker.js'), ...tools]) walk(entry);
  for (const file of seen) {
    const rel = relative(SERVICE, file);
    if (rel.startsWith('..')) assert.fail(`${rel} is outside chat-service`);
    const top = rel.split('/')[0];
    if (rel === top) {
      assert.ok(scp.includes(rel) && moved.includes(rel) && owned.includes(rel), `${rel} is shipped (scp, mv and chown)`);
    } else if (top === 'indexing') assert.match(deploy, /scp -i "\$KEY" indexing\/\*\.js/);
    else if (top === 'connector') assert.ok(deploy.includes('scp -i "$KEY" connector/*.js') && deploy.includes('scp -i "$KEY" connector/tools/*.js'));
    else assert.ok(folders.includes(top), `${rel} is in a folder deploy.sh ships`);
  }
  // The data the modules read at import: each folder holds its files.
  for (const d of folders) assert.ok(readdirSync(join(SERVICE, d)).some((f) => f.endsWith('.json')), `${d}/ has its data`);
});

test('get_firm_rules gives a draft the firm-wide style sheet, or a kind of document\'s own with its documentTypeId', async () => {
  const { firmRulesText } = await import('../connector/tools/firmRules.js');
  const firmRules = (await import('../connector/tools/firmRules.js')).default;
  const { FIRM_STYLE_CORE } = await import('../firmRules.js');
  assert.ok(firmRulesText('draft').endsWith(FIRM_STYLE_CORE));
  assert.ok(!firmRulesText('answer').includes(FIRM_STYLE_CORE) && !firmRulesText('review').includes(FIRM_STYLE_CORE));
  const T = '56565656-5656-4565-8565-565656565656';
  const supabase = { from: () => { const q = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve({ data: { id: T, name: 'Escrow Agreement' }, error: null }) }; return q; } };
  const [tool] = firmRules({ supabase });
  const out = await tool.run({ task: 'draft', documentTypeId: T });
  assert.ok(out.endsWith(styleSheetText('Escrow Agreement')));
  assert.equal(await tool.run({ task: 'draft' }), firmRulesText('draft'));
  await assert.rejects(tool.run({ task: 'draft', documentTypeId: 'nope' }), /documentTypeId must be a document type id/);
});
