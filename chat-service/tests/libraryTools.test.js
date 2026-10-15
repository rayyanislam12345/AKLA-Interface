import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeChunks, readSection, sectionIndex, sectionAt, parseSection, resolveAct, sameLaw, bestCopy,
  findPassages, createSourceRegistry, citedNumbers, labelFor, makeToolRunner, clearCaches,
} from '../libraryTools.js';
import { citationIssues } from '../chatState.js';

// An Act laid out the way the library holds the Companies Act, 2017: a
// contents list naming every section, then the body (with a stray "p. 198."
// and a cross-reference to "section 200." inside it), then a Schedule whose
// paragraphs are numbered from 1 again.
const ACT = [
  'Updated till 7.10.2022 THE COMPANIES ACT, 2017 CONTENTS PART XII PROVISIONS REGARDING INVESTMENTS SECTIONS.',
  '195. Power to borrow. 196. Registration of charges. 197. Restriction on investments. 198. Loans to directors. 199. Investments in associated companies and undertaking. 200. Investments of company to be held in its own name. 201. Method of contracting.',
  'Page 12 of 401 PART XII PROVISIONS REGARDING INVESTMENTS',
  '195. Power to borrow.—The board may borrow on behalf of the company within the limits the members set by special resolution.',
  '196. Registration of charges.—Every charge created by a company shall be registered with the registrar, see Gazette p. 198. This applies to charges created before the commencement of this Act too.',
  '197. Restriction on investments.—A company shall not make an investment except as this Part allows.',
  '198. Loans to directors.—No company shall make any loan to a director except with the approval of the members.',
  '199. Investments in associated companies and undertaking.—(1) A company shall not make any investment in any of its associated companies or associated undertakings except under the authority of a special resolution. (2) The return on any such investment shall be arms-length and in accordance with the trade policy of the company, as provided under section 200. Nothing here applies to a bank.',
  '200. Investments of company to be held in its own name.—(1) All investments made by a company on its own behalf shall be made and held by it in its own name.',
  '201. Method of contracting.—A contract which, if made between individuals, would be required by law to be in writing may be made on behalf of the company in writing signed by any person acting under its authority.',
  'FIRST SCHEDULE 1. Interpretation.—In these regulations the Act means the Companies Act, 2017. 2. Share capital.—The authorised capital is as stated in the memorandum.',
].join(' ');

test('overlapping chunks are rebuilt into one text, the repeated words dropped', () => {
  const words = Array.from({ length: 1500 }, (_, i) => `w${i}`);
  // Windows of 1,000 words overlapping by 200, newlines collapsed.
  const chunks = [words.slice(0, 1000), words.slice(800, 1500)].map((w) => w.join(' '));
  assert.equal(mergeChunks(chunks), words.join(' '));
  // Three chunks, the last starting inside the second.
  const three = [words.slice(0, 600), words.slice(500, 1100), words.slice(900, 1500)].map((w) => w.join(' '));
  assert.equal(mergeChunks(three), words.join(' '));
});

test('chunks that do not overlap are joined with a space, and odd spacing is evened out', () => {
  assert.equal(mergeChunks(['alpha beta  gamma', 'delta\nepsilon', '', 'zeta']), 'alpha beta gamma delta epsilon zeta');
  // A repeat longer than the 400-word window is not taken for overlap.
  const long = Array.from({ length: 450 }, (_, i) => `x${i}`).join(' ');
  assert.equal(mergeChunks([long, long]).split(' ').length, 900);
});

test('the copy of an Act with the most text is read, each chunk once, in order', () => {
  const rows = [
    { content: 'b', metadata: { storage_path: 'small', chunk_index: 0 } },
    { content: 'second part', metadata: { storage_path: 'big', chunk_index: 1 } },
    { content: 'first part', metadata: { storage_path: 'big', chunk_index: 0 } },
    { content: 'first part again', metadata: { storage_path: 'big', chunk_index: 0 } },
  ];
  assert.deepEqual(bestCopy(rows).map((r) => r.content), ['first part', 'second part']);
});

test('a section is read from the body, not its line in the contents', () => {
  const s = readSection(ACT, '199');
  assert.ok(s);
  assert.equal(s.section, '199');
  assert.equal(s.heading, 'Investments in associated companies and undertaking');
  assert.ok(s.text.startsWith('199. Investments in associated companies and undertaking.—(1)'));
  assert.ok(s.text.includes('arms-length'));
  // It ends where section 200 begins, and the cross-reference to "section
  // 200." inside it is not taken for that heading.
  assert.ok(s.text.includes('as provided under section 200. Nothing here applies to a bank.'));
  assert.ok(!s.text.includes('Investments of company to be held'));
  // The same answer without the body's index, by the contents-gap rule alone.
  const bare = readSection(ACT, 'section 199', []);
  assert.equal(bare.text, s.text);
});

test('section numbers are read loosely, and a section that is not there is null', () => {
  assert.deepEqual(parseSection('s. 199(2)'), { base: 199, suffix: '', label: '199' });
  assert.deepEqual(parseSection('Section 83a'), { base: 83, suffix: 'A', label: '83A' });
  assert.equal(parseSection('the definitions'), null);
  assert.equal(readSection(ACT, '999'), null);
  // A section is read whole past a stray number inside it.
  assert.ok(readSection(ACT, '196').text.endsWith('commencement of this Act too.'));
  assert.ok(readSection(ACT, '198').text.startsWith('198. Loans to directors.—No company'));
  // The last section ends where the Schedule begins.
  const last = readSection(ACT, '201');
  assert.ok(last.text.endsWith('acting under its authority.'));
});

test('the body headings are indexed; stray numbers, the contents and the Schedule are not sections', () => {
  const index = sectionIndex(ACT);
  assert.deepEqual(index.filter((e) => e.section).map((e) => e.section), ['195', '196', '197', '198', '199', '200', '201']);
  assert.equal(index[index.length - 1].section, null);
  assert.equal(sectionAt(index, ACT.indexOf('arms-length')), '199');
  assert.equal(sectionAt(index, ACT.indexOf('Interpretation.—')), null);
  assert.equal(sectionAt(index, 10), null);
  assert.equal(sectionAt(index, ACT.indexOf('This applies to charges')), '196');
});

const LIBRARY = [
  { act_name: 'Companies Act, 2017', chunk_count: 198 },
  { act_name: 'Copyright Ordinance, 1962', chunk_count: 25 },
  { act_name: 'Code of Civil Procedure (CPC) , 1908 (Under Review)', chunk_count: 178 },
  { act_name: 'Public Private Partnership Authority Act, 2017', chunk_count: 30 },
  { act_name: 'Public Private Partnership Authority Act, 2017 (Act No. VIII of 2017)', chunk_count: 9 },
  { act_name: 'Limited Liability Partnership Act, 2017', chunk_count: 17 },
];

test('a law named loosely resolves to the library\'s copy, and a wrong year does not', () => {
  assert.equal(resolveAct('Companies Act 2017', LIBRARY)?.act_name, 'Companies Act, 2017');
  assert.equal(resolveAct('the companies act', LIBRARY)?.act_name, 'Companies Act, 2017');
  assert.equal(resolveAct('THE COMPANIES ACT, 2017', LIBRARY)?.act_name, 'Companies Act, 2017');
  assert.equal(resolveAct('CPC', LIBRARY)?.act_name, 'Code of Civil Procedure (CPC) , 1908 (Under Review)');
  assert.equal(resolveAct('PPP Authority Act', LIBRARY), null);
  assert.equal(resolveAct('Public Private Partnership Authority Act, 2017.', LIBRARY)?.act_name, 'Public Private Partnership Authority Act, 2017');
  assert.equal(resolveAct('Companies Ordinance, 1984', LIBRARY), null);
  assert.equal(resolveAct('Copyright', LIBRARY)?.act_name, 'Copyright Ordinance, 1962');
  assert.deepEqual(sameLaw('Public Private Partnership Authority Act, 2017', LIBRARY).sort(), [
    'Public Private Partnership Authority Act, 2017', 'Public Private Partnership Authority Act, 2017 (Act No. VIII of 2017)',
  ]);
});

test('passages are found where the words cluster, "arm\'s length" finding "arms-length"', () => {
  const [best] = findPassages(ACT, "arm's length return on investment", { window: 400 });
  assert.ok(best);
  assert.ok(ACT.slice(best.start, best.end).includes('arms-length'));
  assert.deepEqual(findPassages(ACT, 'insolvency moratorium'), []);
});

test('sources keep one number for the whole chat', () => {
  const earlier = [
    { sources: [{ n: 1, id: 'a', scope: 'statute', label: 'Companies Act, 2017', excerpt: 'old text one' }] },
    { metadata: { sources: [{ id: 'legacy', content: 'no number' }] } },
    { sources: [{ n: 10, id: 'b', scope: 'statute', label: 'Companies Act, 2017 — section 199', excerpt: '199. Investments …' }] },
  ];
  const r = createSourceRegistry(earlier);
  assert.deepEqual([...r.valid()].sort((x, y) => x - y), [1, 10]);
  const again = r.register({ id: 'b', scope: 'statute', act_name: 'Companies Act, 2017', text: 'x' });
  assert.equal(again.entry.n, 10);
  assert.equal(again.fresh, false);
  const fresh = r.register({ id: 'act:Companies Act, 2017#s199', scope: 'statute', act_name: 'Companies Act, 2017', section: '199', text: 'y'.repeat(7000), similarity: null });
  assert.equal(fresh.entry.n, 11);
  assert.equal(fresh.entry.label, 'Companies Act, 2017 — section 199');
  assert.equal(fresh.entry.excerpt.length, 6000);
  assert.equal(fresh.entry.content.length, 240);
  assert.equal(r.register({ id: 'act:Companies Act, 2017#s199', scope: 'statute', text: 'z' }).entry.n, 11);
  const turn = r.thisTurn();
  assert.equal(turn.length, 1);
  assert.deepEqual(Object.keys(turn[0]).sort(), ['act_name', 'content', 'excerpt', 'filename', 'id', 'label', 'n', 'scope', 'section', 'similarity', 'url'].sort());
  const block = r.earlierBlock();
  assert.ok(block.indexOf('[Source 10]') < block.indexOf('[Source 1]'), 'most recent first');
  assert.ok(!block.includes('[Source 11]'), 'only earlier turns');
  assert.ok(r.valid().has(11));
});

test('citations are read in all their forms, and only unknown numbers are flagged', () => {
  assert.deepEqual(citedNumbers('See [Source 10], [Sources 3, 5] and [Source 7 and 2].'), [2, 3, 5, 7, 10]);
  assert.deepEqual(citationIssues('Per [Source 10] and [Source 12].', new Set([1, 10, 11])), [12]);
  assert.deepEqual(citationIssues('Text [Source 1] and [Source 9]', 2), [9]);
  assert.equal(labelFor({ scope: 'precedent', filename: 'EPC.docx' }), 'EPC.docx');
});

// A stand-in for the Supabase client: enough of the query builder for the
// law library reads, answering from rows held in memory.
function fakeSupabase(rows) {
  return {
    from() {
      const filters = [];
      let range = [0, Infinity];
      const builder = {
        select() { return builder; },
        eq(column, value) { filters.push([column, value]); return builder; },
        order() { return builder; },
        range(from, to) { range = [from, to]; return builder; },
        then(resolve) {
          const data = rows.filter((row) => filters.every(([c, v]) => (c === 'is_statute' ? row.is_statute === v : c === 'metadata->>act_name' ? row.metadata.act_name === v : true)))
            .map((row) => ({ ...row, act_name: row.metadata.act_name }))
            .slice(range[0], range[1] + 1);
          resolve({ data, error: null });
        },
      };
      return builder;
    },
  };
}

test('read_act_section returns the section as a numbered source; a failed lookup is an error result, not a throw', async () => {
  clearCaches();
  const words = ACT.split(' ');
  const rows = [];
  for (let i = 0, k = 0; i < words.length; i += 60, k++) rows.push({ id: `c${k}`, is_statute: true, content: words.slice(Math.max(0, i - 20), i + 60).join(' '), metadata: { act_name: 'Companies Act, 2017', chunk_index: k, source_url: 'https://pakistancode.gov.pk/x' } });
  const registry = createSourceRegistry([{ sources: [{ n: 4, id: 'old', scope: 'statute', label: 'x', excerpt: 'x' }] }]);
  const notices = [];
  let grew = 0;
  const run = makeToolRunner({ supabase: fakeSupabase(rows), voyageKey: 'k', registry, notice: (t) => notices.push(t), onSources: () => grew++ });

  const ok = await run({ id: 'tu1', name: 'read_act_section', input: { act: 'Companies Act 2017', section: '199' } });
  assert.equal(ok.tool_use_id, 'tu1');
  assert.ok(!ok.is_error);
  assert.ok(ok.content.includes('[Source 5] Companies Act, 2017 — section 199'));
  assert.ok(ok.content.includes('arms-length'));
  assert.ok(!ok.content.includes('Investments of company to be held'));
  assert.deepEqual(notices, ['Reading Companies Act 2017, section 199…']);
  assert.equal(grew, 1);
  const [entry] = registry.thisTurn();
  assert.equal(entry.id, 'act:Companies Act, 2017#s199');
  assert.equal(entry.url, 'https://pakistancode.gov.pk/x');

  const missing = await run({ id: 'tu2', name: 'read_act_section', input: { act: 'Companies Act, 2017', section: '999' } });
  assert.equal(missing.is_error, true);
  assert.match(missing.content, /Section 999 was not found/);
  const noLaw = await run({ id: 'tu3', name: 'read_act_section', input: { act: 'Insolvency Act, 2050', section: '1' } });
  assert.equal(noLaw.is_error, true);
  const unknown = await run({ id: 'tu4', name: 'delete_everything', input: {} });
  assert.equal(unknown.is_error, true);
  const empty = await run({ id: 'tu5', name: 'search_law_library', input: {} });
  assert.equal(empty.is_error, true);
  clearCaches();
});
