// What changed between versions: alignment by clause and by likeness, the
// nature of each change, the noise that is hidden, and the worker's hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, matchingBlocks, similarity, sides, MAX_SIDE_CHARS } from '../versionCompare.js';
import { checkAndCompare, recordChecks } from '../indexing/pipeline.js';
import { StopRequested } from '../indexing/extract.js';

const doc = (lines, side) => ({ blocks: lines.map((text) => (typeof text === 'string' ? { text } : text)), ...(side ? { side } : {}) });
const shown = (r) => r.items.filter((i) => i.nature !== 'formatting_only');
const line = (i) => `${i.kind} | ${i.nature} | ${i.where}`;

const BASE = [
  'CONCESSION AGREEMENT',
  'AKLA Draft: 16 September 2026',
  'CONTENTS',
  '1. DEFINITIONS .......... 3',
  '2. OBLIGATIONS .......... 5',
  '1. DEFINITIONS',
  '1.1 “Agency” means the Sindh Public Private Partnership Unit;',
  '1.2 “Term” means the period of thirty (30) years from the Commercial Operations Date;',
  '2. OBLIGATIONS',
  '2.1 The Concessionaire shall design and build the motorway in accordance with the Specifications.',
  '2.2 The Concessionaire shall pay a concession fee of PKR 1,000,000 (Pakistani Rupees One Million only) each year.',
  '2.3 The Agency shall hand over the Site free of encumbrances.',
  '2.4 The Agency shall grant the Concessionaire every permit it needs.',
  '2.5 The Lenders may step in on a Concessionaire Event of Default.',
  '2.6 Notices shall be given in writing to the addresses in Schedule 1.',
  'SCHEDULE 1 – NOTICES',
  '1. The Agency: Karachi.',
  '2. The Concessionaire: Lahore.',
];
const edit = (fn) => { const lines = [...BASE]; fn(lines); return lines; };

test('a changed number is a numbers, dates and names change at its clause', () => {
  const r = compareVersions(doc(BASE), doc(edit((l) => { l[10] = l[10].replace('1,000,000 (Pakistani Rupees One Million only)', '2,000,000 (Pakistani Rupees Two Million only)'); })));
  assert.deepEqual(r.items.map(line), ['changed | numbers_dates_names | Clause 2.2']);
  assert.match(r.items[0].before, /1,000,000/);
  assert.match(r.items[0].after, /2,000,000/);
  assert.deepEqual(r.counts, { changed: 1, added: 0, removed: 0, moved: 0 });
  assert.equal(r.shown, 1); assert.equal(r.hidden, 0);
});

test('an added clause, and the clauses after it renumbered, read as one addition and one renumbering line', () => {
  const r = compareVersions(doc(BASE), doc(edit((l) => {
    l.splice(12, 3,
      '2.4 The Concessionaire shall insure the Project at its own cost.',
      '2.5 The Agency shall grant the Concessionaire every permit it needs.',
      '2.6 The Lenders may step in on a Concessionaire Event of Default.',
      '2.7 Notices shall be given in writing to the addresses in Schedule 1.');
  })));
  assert.deepEqual(shown(r).map(line), ['added | clause_added | Clause 2.4', 'changed | renumbering | Clause 2.5 to Clause 2.7']);
  assert.equal(r.items[1].before, '3 paragraphs numbered 2.4 to 2.6');
  assert.equal(r.items[1].after, 'now numbered 2.5 to 2.7, words unchanged');
});

test('a removed clause renumbers the rest; a cross-reference updated to match is renumbering, not wording', () => {
  const r = compareVersions(doc([...BASE, '3. Clause 2.6 survives termination.']), doc(edit((l) => {
    l.splice(11, 1);
    l[11] = '2.3 The Agency shall grant the Concessionaire every permit it needs.';
    l[12] = '2.4 The Lenders may step in on a Concessionaire Event of Default.';
    l[13] = '2.5 Notices shall be given in writing to the addresses in Schedule 1.';
    l.push('3. Clause 2.5 survives termination.');
  })));
  assert.deepEqual(shown(r).map(line), [
    'removed | clause_removed | Clause 2.3',
    'changed | renumbering | Clause 2.3 to Clause 2.5',
    'changed | renumbering | Schedule 1, Clause 3',
  ]);
});

test('a change only to the contents page, the cover date and spacing is hidden as formatting', () => {
  const r = compareVersions(doc(BASE, { headers: ['AKLA Draft 16.09.26'] }), doc(edit((l) => {
    l[1] = 'AKLA Draft: 3 October 2026';
    l[4] = '2. OBLIGATIONS .......... 6';
    l[9] = '2.1  The Concessionaire shall design and build the motorway, in accordance with the “Specifications”';
    l[15] = 'Schedule 1 – Notices';
  }), { headers: ['AKLA Draft 03.10.26'] }));
  assert.equal(r.shown, 0, JSON.stringify(r.items, null, 1));
  assert.equal(r.hidden, 5);
  assert.deepEqual(r.items.map((i) => i.noise ?? i.nature).sort(), ['contents', 'cover date', 'formatting_only', 'formatting_only', 'page header'].sort());
  assert.match(r.notes[0], /Only formatting changed/);
  const contents = r.items.find((i) => i.noise === 'contents');
  assert.equal(contents.before, '2. OBLIGATIONS .......... 5');
  assert.equal(contents.after, '2. OBLIGATIONS .......... 6');
});

test('definitions and schedules are named as such; a reworded clause is wording', () => {
  const r = compareVersions(doc(BASE), doc(edit((l) => {
    l[6] = '1.1 “Agency” means the Sindh Public Private Partnership Unit or its successor;';
    l[9] = '2.1 The Concessionaire shall design, build and commission the motorway in accordance with the Specifications.';
    l[17] = '2. The Concessionaire: its registered office in Lahore.';
    l.splice(8, 0, '1.3 “Lenders” means the banks financing the Project;');
  })));
  assert.deepEqual(r.items.map(line), [
    'changed | definitions | Clause 1.1',
    'added | definitions | Clause 1.3',
    'changed | wording | Clause 2.1',
    'changed | schedule | Schedule 1, Clause 2',
  ]);
});

test('a clause moved elsewhere is one move, not a removal and an addition', () => {
  const r = compareVersions(doc(BASE), doc(edit((l) => {
    const [moved] = l.splice(13, 1);
    l.splice(9, 0, moved);
  })));
  const moves = r.items.filter((i) => i.kind === 'moved');
  assert.equal(moves.length, 1);
  assert.match(moves[0].after, /The Lenders may step in/);
  assert.equal(r.counts.added, 0); assert.equal(r.counts.removed, 0);
});

test('two unrelated files saved as versions of one are said to be unrelated', () => {
  const other = Array.from({ length: 12 }, (_, i) => `${i + 1}. Tariff determination item ${i} for the generation licence of the power company under NEPRA rules.`);
  const r = compareVersions(doc(BASE), doc(other));
  assert.equal(r.unrelated, true);
  assert.deepEqual(r.items, []);
  assert.match(r.notes[0], /share almost no text/);
});

test('identical versions report no changes', () => {
  const r = compareVersions(doc(BASE), doc(BASE));
  assert.equal(r.identical, true);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.notes, ['No changes in the text.']);
});

test('before and after are cut to the stretch around the first difference', () => {
  const long = 'x'.repeat(2000);
  const { before, after } = sides(`${long} thirty (30) days ${long}`, `${long} sixty (60) days ${long}`);
  assert.ok(before.length <= MAX_SIDE_CHARS && after.length <= MAX_SIDE_CHARS);
  assert.match(before, /thirty \(30\)/); assert.match(after, /sixty \(60\)/);
  assert.ok(before.startsWith('…') && before.endsWith('…'));
});

test('matching blocks and likeness', () => {
  assert.deepEqual(matchingBlocks(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd']), [[0, 0, 1], [2, 2, 2]]);
  assert.equal(similarity('the fee is due', 'the fee is due'), 1);
  assert.equal(similarity('alpha beta', 'gamma delta'), 0);
});

// ------------------------------------------------------------ the worker's hook
function fakeDb({ previous = null, files = {}, lookupError = null } = {}) {
  const calls = [];
  const query = {
    select() { return this; }, eq() { return this; }, lt() { return this; }, order() { return this; }, limit() { return this; },
    async maybeSingle() { return lookupError ? { data: null, error: lookupError } : { data: previous, error: null }; },
  };
  return {
    calls,
    from: () => query,
    storage: { from: () => ({ async download(path) {
      if (!(path in files)) return { data: null, error: { statusCode: '404', message: 'Object not found' } };
      return { data: new Blob([files[path]]), error: null };
    } }) },
    async rpc(name, args) { calls.push({ name, args }); return { data: true, error: null }; },
  };
}
const read = (lines, format = 'txt') => ({ format, blocks: lines.map((text) => ({ text })) });
const job = { id: 'job', run_id: 'run', bucket: 'matter-documents' };
const version = { id: 'v2', version_number: 2, matter_document_id: 'doc' };

test('the worker checks the version and compares it with the one before, read again from storage', async () => {
  const db = fakeDb({ previous: { id: 'v1', version_number: 1, storage_path: 'p/v1.txt', file_name: 'Draft v1.txt' }, files: { 'p/v1.txt': BASE.join('\n\n') } });
  const current = read(edit((l) => { l[7] = '1.2 “Term” means the period of twenty-five (25) years from the Commercial Operations Date;'; }));
  const checks = await checkAndCompare(db, job, version, current, {});
  assert.equal(checks.comparedWith, 'v1');
  assert.equal(checks.proofCheck.version, 1);
  assert.deepEqual(checks.changes.previous, { version_id: 'v1', version_number: 1, file_name: 'Draft v1.txt' });
  assert.deepEqual(checks.changes.items.map(line), ['changed | numbers_dates_names | Clause 1.2']);
  assert.equal(await recordChecks(db, job, version.id, checks), true);
  assert.deepEqual(db.calls[0], { name: 'record_version_checks', args: { p_version_id: 'v2', p_run_id: 'run', p_proof_check: checks.proofCheck, p_changes: checks.changes, p_compared_with: 'v1' } });
});

test('a first version is checked and not compared', async () => {
  const checks = await checkAndCompare(fakeDb(), job, { ...version, version_number: 1 }, read(BASE), {});
  assert.equal(checks.changes, null); assert.equal(checks.comparedWith, null);
  assert.equal(typeof checks.proofCheck.total, 'number');
});

test('a compare that cannot be done is recorded in place of the result, and never fails the reading', async () => {
  const missing = await checkAndCompare(fakeDb({ previous: { id: 'v1', version_number: 1, storage_path: 'p/gone.docx', file_name: 'gone.docx' } }), job, version, read(BASE, 'docx'), {});
  assert.equal(missing.changes.error, 'The previous version (v1) could not be read: The file is missing from storage. Upload it again.');
  assert.equal(missing.comparedWith, 'v1');
  const sheet = await checkAndCompare(fakeDb({ previous: { id: 'v1', version_number: 1, storage_path: 'p/v1.xlsx', file_name: 'v1.xlsx' } }), job, version, read(BASE, 'docx'), {});
  assert.match(sheet.changes.skipped, /cannot be compared/);
  const lookup = await checkAndCompare(fakeDb({ lookupError: { message: 'boom' } }), job, version, read(BASE), {});
  assert.match(lookup.changes.error, /could not be looked up/);
  const slides = await checkAndCompare(fakeDb(), job, { ...version, version_number: 1 }, read(['[Slide 1]', 'Title'], 'pptx'), {});
  assert.match(slides.proofCheck.skipped, /Word, PDF and text files only/);
});

test('a worker asked to stop still stops during the comparison', async () => {
  const db = fakeDb({ previous: { id: 'v1', version_number: 1, storage_path: 'p/v1.txt', file_name: 'v1.txt' }, files: { 'p/v1.txt': 'text' } });
  await assert.rejects(checkAndCompare(db, job, version, read(BASE), { checkStop: () => { throw new StopRequested('worker stopping'); } }), StopRequested);
});

test('saving the checks never throws, even before the migration is applied', async () => {
  const db = { async rpc() { return { data: null, error: { message: 'Could not find the function public.record_version_checks' } }; } };
  const logs = [];
  assert.equal(await recordChecks(db, job, 'v2', { proofCheck: {}, changes: null, comparedWith: null }, (m) => logs.push(m)), false);
  assert.match(logs[0], /checks not saved/);
});
