// The clause bank: headings normalised, the lookup's four steps (heading,
// synonyms, a longer heading, a paragraph naming it) with no embedding call,
// examples per precedent cut at 2,000 characters, the prompt block, and the
// connector tool get_clause_examples built on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { headingNorm, synonymsFor, clauseExamples, clauseExamplesText, clauseHeadings, groupExamples, MAX_EXAMPLE_CHARS, NEEDS_MIGRATION } from '../clauseBank.js';
import clauses, { clauseExamplesReply } from '../connector/tools/clauses.js';
import { createHubTools, MODULE_TOOL_NAMES } from '../connector/tools.js';

const ESCROW = '00000000-0000-4000-8000-0000000000e1';
const NOBODY = '00000000-0000-4000-8000-0000000000ff';

// An in-memory precedent_passages / document_types with the query methods the bank uses.
function fakeSupabase({ passages = [], types = [{ id: ESCROW, name: 'Escrow Agreement' }], error = null } = {}) {
  const calls = [];
  const from = (table) => {
    const filters = [];
    let limit = Infinity;
    const orders = [];
    const q = {
      select() { return q; },
      eq(col, v) { filters.push((r) => r[col] === v); calls.push(['eq', table, col, v]); return q; },
      in(col, vs) { filters.push((r) => vs.includes(r[col])); calls.push(['in', table, col, vs]); return q; },
      ilike(col, pattern) {
        const re = new RegExp(`^${pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
        filters.push((r) => r[col] != null && re.test(r[col]));
        calls.push(['ilike', table, col, pattern]);
        return q;
      },
      not(col, op, v) { filters.push((r) => !(op === 'is' && v === null ? r[col] === null || r[col] === undefined : false)); return q; },
      order(col) { orders.push(col); return q; },
      limit(n) { limit = n; return q; },
      maybeSingle() { return Promise.resolve(error ? { data: null, error } : { data: rows()[0] ?? null, error: null }); },
      then(resolve, reject) { return Promise.resolve(error ? { data: null, error } : { data: rows(), error: null }).then(resolve, reject); },
    };
    const rows = () => {
      const src = table === 'document_types' ? types : passages;
      const out = src.filter((r) => filters.every((f) => f(r)));
      out.sort((a, b) => { for (const c of orders) { const x = a[c] ?? ''; const y = b[c] ?? ''; if (x < y) return -1; if (x > y) return 1; } return 0; });
      return out.slice(0, limit);
    };
    return q;
  };
  return { from, calls };
}

let nextId = 1;
const passage = (file, heading, body, { ordinal = nextId, clause = null, chunk = 0, type = ESCROW } = {}) => ({
  id: nextId++, document_id: `${file}-doc`, storage_path: `precedent/${type}/${file}`, filename: file, document_type_id: type,
  chunk_index: chunk, ordinal, body, heading, heading_norm: headingNorm(heading), clause_no: clause, family: 'escrow',
});

test('headings are normalised the way the migration does: label, numbers, case, punctuation, plurals', () => {
  assert.equal(headingNorm('ARTICLE 14 – GOVERNING LAWS'), 'governing law');
  assert.equal(headingNorm('14.1 Governing Law'), 'governing law');
  assert.equal(headingNorm('Representations & Warranties'), 'representation and warranty');
  assert.equal(headingNorm('Schedule B – Specific Definitions'), 'specific definition');
  assert.equal(headingNorm('SCHEDULE OF PAYMENTS'), 'schedule of payment');
  assert.equal(headingNorm('The Appointment'), 'appointment');
  assert.equal(headingNorm('(a) Costs and Expenses'), 'cost and expense');
  assert.equal(headingNorm('Process and Status'), 'process and status');
  assert.equal(headingNorm('Parties'), 'party');
  assert.equal(headingNorm('  '), null);
  assert.equal(headingNorm(null), null);
});

test('synonyms come from the family first, then the table every family shares', () => {
  assert.ok(synonymsFor('Governing Law').includes('applicable law'));
  assert.ok(synonymsFor('Dispute Resolution').includes('arbitration'));
  assert.ok(synonymsFor('Release of Escrow Amount', 'escrow').includes('disbursement'));
  assert.deepEqual(synonymsFor('Release of Escrow Amount', 'memo'), []);
  assert.ok(!synonymsFor('Governing Law').includes('governing law'), 'not the heading itself');
});

test('a lookup matches the heading exactly first, one example per precedent, in reading order, overlap repeats dropped', async () => {
  const passages = [
    passage('SKM58.docx', 'Governing Law', '14.1 This Agreement shall be governed by the laws of Pakistan.', { clause: '14', ordinal: 2 }),
    passage('SKM58.docx', 'Governing Law', '14.0 heading paragraph of the clause, which opens it.', { clause: '14', ordinal: 1 }),
    passage('SKM58.docx', 'Governing Law', '14.1 This Agreement shall be governed by the laws of Pakistan.', { clause: '14', ordinal: 1, chunk: 1 }),
    passage('MEW.docx', 'GOVERNING LAWS', 'This Agreement shall be governed by and construed in accordance with the laws of the Islamic Republic of Pakistan.', { clause: 'Article 14' }),
    passage('OTHER.docx', 'Notices', 'Every notice shall be in writing.'),
  ];
  const supabase = fakeSupabase({ passages });
  const found = await clauseExamples({ supabase, typeId: ESCROW, heading: 'Article 9 – Governing Law', k: 3 });
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((e) => e.match), ['heading', 'heading']);
  const skm = found.find((e) => e.file === 'SKM58.docx');
  assert.equal(skm.text, '14.0 heading paragraph of the clause, which opens it.\n\n14.1 This Agreement shall be governed by the laws of Pakistan.');
  assert.equal(skm.clause, '14');
  assert.ok(!supabase.calls.some(([, , col]) => col === 'embedding'), 'no vector anywhere');
});

test('then the synonyms, a longer heading with the same words, and last a paragraph naming it', async () => {
  const passages = [
    passage('A.docx', 'Applicable Law', 'This Agreement shall be governed by the laws of Pakistan.', { clause: '20' }),
    passage('B.docx', 'Governing Law of this Agreement', 'The courts at [●] shall have jurisdiction.', { clause: '21' }),
    passage('C.docx', null, 'The governing law of this Agreement is the law of Pakistan, and the parties submit to it.'),
  ];
  const found = await clauseExamples({ supabase: fakeSupabase({ passages }), typeId: ESCROW, heading: 'Governing Law', k: 5 });
  assert.deepEqual(found.map((e) => [e.file, e.match]), [['A.docx', 'synonym'], ['B.docx', 'similar'], ['C.docx', 'text']]);
});

test('k is capped at five; an example is cut at 2,000 characters; nothing is asked of the database without a heading', async () => {
  const long = Array.from({ length: 6 }, (_, i) => passage('L.docx', 'Fees', `${'The Escrow Agent shall be paid a fee. '.repeat(15)}(${i})`, { ordinal: i + 1 }));
  const [e] = await clauseExamples({ supabase: fakeSupabase({ passages: long }), typeId: ESCROW, heading: 'Fees', k: 1 });
  assert.ok(e.text.length <= MAX_EXAMPLE_CHARS);
  assert.equal(e.cut, true);
  const many = Array.from({ length: 8 }, (_, i) => passage(`F${i}.docx`, 'Fees', 'A fee shall be paid within thirty (30) days.'));
  assert.equal((await clauseExamples({ supabase: fakeSupabase({ passages: many }), typeId: ESCROW, heading: 'Fees', k: 50 })).length, 5);
  const supabase = fakeSupabase({ passages: many });
  assert.deepEqual(await clauseExamples({ supabase, typeId: ESCROW, heading: '14.' }), []);
  assert.equal(supabase.calls.length, 0);
});

test('before the migration the lookup says so in one sentence', async () => {
  const supabase = fakeSupabase({ error: { message: 'column precedent_passages.heading_norm does not exist' } });
  await assert.rejects(clauseExamples({ supabase, typeId: ESCROW, heading: 'Fees' }), new RegExp(NEEDS_MIGRATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the prompt block names each example\'s source and says to follow it and name it', () => {
  const text = clauseExamplesText(groupExamples([passage('SKM58.docx', 'Governing Law', 'This Agreement shall be governed by the laws of Pakistan.', { clause: '14' })], 'heading'), { heading: 'Governing Law' });
  assert.match(text, /^THE FIRM'S OWN VERSIONS OF “Governing Law”/);
  assert.match(text, /\[Firm clause 1\] SKM58\.docx, 14 \(Governing Law\) — same heading:\nThis Agreement shall be governed/);
  assert.match(text, /name the precedent you followed/);
  assert.equal(clauseExamplesText([]), '');
});

test('the headings a type uses, most used first, for a heading that finds nothing', async () => {
  const passages = [passage('A.docx', 'Notices', 'x'.repeat(50)), passage('A.docx', 'Notices', 'y'.repeat(50)), passage('B.docx', 'Fees', 'z'.repeat(50))];
  assert.deepEqual(await clauseHeadings({ supabase: fakeSupabase({ passages }), typeId: ESCROW }), ['Notices', 'Fees']);
});

test('get_clause_examples is a read-only connector tool, listed in the pinned order, answering with sources', async () => {
  assert.ok(MODULE_TOOL_NAMES.includes('get_clause_examples'));
  const passages = [passage('SKM58.docx', 'Governing Law', 'This Agreement shall be governed by the laws of Pakistan.', { clause: '14' })];
  const list = createHubTools({ supabase: fakeSupabase({ passages }), voyageKey: 'v', log: () => {}, modules: [clauses] });
  const tool = list.find((t) => t.name === 'get_clause_examples');
  assert.ok(tool);
  assert.equal(tool.write, undefined);
  const out = await tool.run({ documentTypeId: ESCROW, heading: 'Governing Law' }, { userId: 'u' });
  const text = typeof out === 'string' ? out : out?.content?.[0]?.text ?? JSON.stringify(out);
  assert.match(text, /1 firm version of “Governing Law” from Escrow Agreement precedents/);
  assert.match(text, /\[Source 1\] SKM58\.docx, 14 \(Governing Law\) — same heading/);
  assert.match(text, /Open in Hub: .*\/precedent-library/);
  const none = await tool.run({ documentTypeId: ESCROW, heading: 'Liquidated Damages' }, { userId: 'u' });
  assert.match(typeof none === 'string' ? none : none?.content?.[0]?.text, /No Escrow Agreement precedent .* “Liquidated Damages”.*use these headings \(try one\): Governing Law/s);
  await assert.rejects(tool.run({ documentTypeId: 'nope', heading: 'Fees' }, { userId: 'u' }), /documentTypeId must be a document type id/);
  await assert.rejects(tool.run({ documentTypeId: NOBODY, heading: 'Fees' }, { userId: 'u' }), /There is no document type with that id/);
});

test('the tool reply with no headings at all says the library holds none yet', () => {
  const text = clauseExamplesReply({ type: { name: 'Board Resolution' }, heading: 'Authorisation', examples: [], headings: [], open: () => 'Open in Hub: x' });
  assert.match(text, /holds no Board Resolution precedents with headings yet/);
  assert.match(text, /New clause — not in the firm's precedents/);
});
