// Piece 1.3: get_document_checks and compare_document_versions
// (connector/tools/documentInsight.js) against a stubbed database, and the
// lifted documentInsight.js that server.js's preview routes and the
// connector share: a stored check or comparison is printed whole and paged,
// one the Hub has not stored is computed from the file under the two-minute
// deadline, and every refusal is a plain sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES, MAX_RESULT_CHARS } from '../connector/tools.js';
import insight, { storedCheck, storedChanges, notDone, pageOf, PAGE_CHARS, CATEGORY_NAMES, BUSY, RESULT_CACHE_MS } from '../connector/tools/documentInsight.js';
import { InsightError, ON_DEMAND_READ_MS, TOO_LONG_MESSAGE, deadlineStop, proofCheckVersion, compareVersionPair } from '../documentInsight.js';

const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D2 = '99999999-9999-4999-8999-999999999999';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const V2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const V3 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const V4 = '12121212-1212-4121-8121-121212121212';
const V5 = '34343434-3434-4343-8343-343434343434';
const V6 = '56565656-5656-4565-8565-565656565656';
const V7 = '78787878-7878-4787-8787-787878787878';
const NOBODY = '00000000-0000-4000-8000-000000000000';

// A Supabase client over plain arrays, as connectorTools.test.js has it,
// with `in` for documentInsight.js's lookup of both versions at once. Every
// file download is counted in `downloads`; `hold` (a promise) is awaited
// before each one, to make a read slow.
function fakeSupabase({ tables = {}, files = {}, hold = null } = {}) {
  const downloads = [];
  const chain = (table) => {
    let rows = [...(tables[table] ?? [])];
    let single = false;
    const q = {
      select() { return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      in(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      order() { return q; }, limit() { return q; }, range() { return q; },
      maybeSingle() { single = true; return q; },
      then(ok, bad) { return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(ok, bad); },
    };
    return q;
  };
  return {
    downloads,
    from: chain,
    storage: { from: (bucket) => ({ download: async (path) => { downloads.push(path); if (hold) await hold; return files[`${bucket}/${path}`] ? { data: new Blob([files[`${bucket}/${path}`]]), error: null } : { data: null, error: { message: 'Object not found' } }; } }) },
  };
}

const md1 = { id: D1, title: 'Concession Agreement', matter_id: P1, document_type: { name: 'Concession Agreement' }, matter: { id: P1, name: 'M6 Motorway' } };
const md2 = { id: D2, title: 'Notes', matter_id: P1, document_type: null, matter: { id: P1, name: 'M6 Motorway' } };
const version = (id, md, n, file, extra = {}) => ({ id, version_number: n, file_name: file, storage_path: `${P1}/${file}`, matter_document_id: md.id, matter_document: md, is_ai_generated: false, created_at: '2026-10-01T08:00:00Z', indexing_status: 'indexed', proof_check: null, changes_from_previous: null, compared_with_version_id: null, ...extra });

const STORED_CHECK = { version: 1, checked_at: '2026-10-01T09:00:00Z', paragraphs: 40, total: 3, counts: { placeholders: 2, undefined_terms: 1, unused_definitions: 0, broken_references: 0, number_words: 0, numbering: 0 }, items: [
  { category: 'placeholders', severity: 'high', where: 'cl. 4.2', text: '[●]', note: 'A blank to fill in.', find: '[●]' },
  { category: 'placeholders', severity: 'medium', where: 'cl. 9.1', text: '[Insert date]', note: '', find: '[Insert date]' },
  { category: 'undefined_terms', severity: 'medium', where: 'cl. 12', text: 'Toll Notification', note: 'used but never defined', find: 'Toll Notification' },
], omitted: { placeholders: 5 }, notes: ['This document amends or supplements another, so its references to clauses, schedules and exhibits were not checked.'] };

const STORED_CHANGES = { version: 1, compared_at: '2026-10-05T09:00:00Z', previous: { version_id: V1, version_number: 1, file_name: 'CA v1.docx' }, counts: { changed: 2, added: 1, removed: 0, moved: 0 }, natures: { wording: 1, numbers_dates_names: 1, clause_added: 1, formatting_only: 1 }, shown: 3, hidden: 1, items: [
  { where: 'cl. 2.1', kind: 'changed', nature: 'numbers_dates_names', before: 'twenty-five (25) years', after: 'thirty (30) years' },
  { where: 'cl. 5', kind: 'added', nature: 'clause_added', before: '', after: 'New clause on tolling.' },
  { where: 'cl. 7', kind: 'changed', nature: 'formatting_only', before: 'a', after: 'a ', noise: 'spacing' },
  { where: 'cl. 9', kind: 'changed', nature: 'wording', before: 'shall use best endeavours', after: 'shall use reasonable endeavours' },
], omitted: 0, notes: [] };

const NOTES_V1 = '1. Definitions\n\n1.1 "Term" means thirty (31) years from the Effective Date.\n\n2. Payment\n\n2.1 The Fee is [●] and the Toll Notification applies.\n\n3. Term\n\n3.1 This Agreement runs for the Term.';
const NOTES_V2 = '1. Definitions\n\n1.1 "Term" means forty (40) years from the Effective Date.\n\n2. Payment\n\n2.1 The Fee is PKR 100 and the Toll Notification applies.\n\n3. Term\n\n3.1 This Agreement runs for the Term.';

function fixtures() {
  return {
    tables: {
      document_versions: [
        version(V1, md1, 1, 'CA v1.docx', { proof_check: STORED_CHECK }),
        version(V2, md1, 2, 'CA v2.docx', { is_ai_generated: true, proof_check: { error: 'The file could not be read.' }, changes_from_previous: STORED_CHANGES, compared_with_version_id: V1 }),
        version(V3, md2, 1, 'notes-v1.txt'),
        version(V4, md2, 2, 'notes-v2.txt', { indexing_status: 'pending' }),
        version(V5, md2, 3, 'notes-v3.xlsx'),
        version(V6, md2, 4, 'notes-v4.txt'),
        version(V7, md2, 5, 'notes-v5.txt', { changes_from_previous: { skipped: 'not comparable' }, compared_with_version_id: V6 }),
      ],
    },
    files: {
      [`matter-documents/${P1}/notes-v1.txt`]: NOTES_V1,
      [`matter-documents/${P1}/notes-v2.txt`]: NOTES_V2,
      [`matter-documents/${P1}/notes-v5.txt`]: NOTES_V2,
    },
  };
}

function tools(extra = {}, fake = {}) {
  const f = fixtures();
  const supabase = fakeSupabase({ ...f, ...fake });
  const list = createHubTools({ supabase, voyageKey: 'v', log: () => {}, hubUrl: 'https://hub.test', modules: [insight], ...extra });
  const byName = Object.fromEntries(list.map((t) => [t.name, t]));
  return { ...f, supabase, list, byName, run: (name, input) => byName[name].run(input, { userId: 'u1' }) };
}

test('the two tools register from connector/tools/documentInsight.js after the built-in eight, read-only in shape', async () => {
  const modules = await loadToolModules();
  assert.ok(modules.some((m) => m.file === 'documentInsight.js'));
  const { list } = tools({ modules });
  const names = list.map((t) => t.name);
  assert.deepEqual(names.slice(0, BUILT_IN_TOOL_NAMES.length), [...BUILT_IN_TOOL_NAMES]);
  assert.ok(names.includes('get_document_checks') && names.includes('compare_document_versions'));
  assert.equal(new Set(names).size, names.length, 'no name twice');
  for (const name of ['get_document_checks', 'compare_document_versions']) {
    const t = list.find((x) => x.name === name);
    assert.ok(t.title && t.description.length > 120, `${name} tells a lawyer's Claude what it is for`);
    assert.ok(t.inputSchema.from, `${name} pages with from`);
    assert.ok(t.inputSchema.recheck, `${name} can be asked to read the file anyway`);
    assert.match(t.description, /one such read at a time/);
  }
  assert.ok(list.find((x) => x.name === 'compare_document_versions').inputSchema.includeFormatting);
});

test('get_document_checks prints a stored check whole: counts, notes, what was not kept, every finding numbered, and the Hub link', async () => {
  const { run } = tools();
  const text = await run('get_document_checks', { versionId: V1 });
  assert.match(text, /^Proof check of Concession Agreement v1 \(CA v1\.docx\), project M6 Motorway: the check the Hub stored when it read the file\.\nOpen in Hub: https:\/\/hub\.test\/ai\/d\/dddddddd-dddd-4ddd-8ddd-dddddddddddd\?embed=1&host=pane\n/);
  assert.match(text, /3 findings \(checked 1 Oct 2026\): blanks and placeholders 2; terms used but not defined 1; definitions never used 0; cross-references to nothing 0; numbers whose words and figures disagree 0; gaps in numbering 0\./);
  assert.match(text, /This document amends or supplements another/);
  assert.match(text, /Not listed \(the Hub keeps at most 100 findings in a category\): 5 more under blanks and placeholders\./);
  assert.match(text, /Findings 1–3 of 3:\n  1\. \[placeholders, high\] cl\. 4\.2: \[●\] — A blank to fill in\.\n  2\. \[placeholders, medium\] cl\. 9\.1: \[Insert date\]\n  3\. \[undefined_terms, medium\] cl\. 12: Toll Notification — used but never defined\n\n\[End of the findings\.\]$/);
  assert.equal(await run('get_document_checks', { versionId: V1, from: 7 }), `${text.split('\n')[0]}\nThere are 3 findings; there is nothing at from: 7.`);
  // The stored shape the summary tool also reads.
  assert.equal(storedCheck({ proof_check: { error: 'x' } }), null);
  assert.equal(storedCheck({ proof_check: null }), null);
  assert.equal(storedCheck({ proof_check: STORED_CHECK }), STORED_CHECK);
  assert.deepEqual(Object.keys(CATEGORY_NAMES), ['placeholders', 'undefined_terms', 'unused_definitions', 'broken_references', 'number_words', 'numbering']);
});

test('a long stored check is paged: every page fits under the cap uncut, numbering runs on, the last page says so', async () => {
  const items = Array.from({ length: 400 }, (_, i) => ({ category: 'undefined_terms', severity: 'low', where: `cl. ${i + 1}`, text: `Term Number ${i + 1} ${'x'.repeat(180)}`, note: 'used but never defined' }));
  const f = fixtures();
  f.tables.document_versions[0].proof_check = { ...STORED_CHECK, total: 400, counts: { ...STORED_CHECK.counts, placeholders: 0, undefined_terms: 400 }, items, omitted: {}, notes: [] };
  const { run } = tools({ supabase: fakeSupabase(f) });
  const pages = [];
  let from = 0;
  for (;;) {
    const page = await run('get_document_checks', { versionId: V1, from });
    pages.push(page);
    assert.ok(page.length <= PAGE_CHARS + 1000 && page.length <= MAX_RESULT_CHARS, `page of ${page.length} chars`);
    assert.doesNotMatch(page, /\[Cut here:/);
    const next = /call get_document_checks again with from: (\d+)\.\]$/.exec(page);
    if (!next) { assert.match(page, /\[End of the findings\.\]$/); break; }
    assert.match(page, new RegExp(`Findings ${from + 1}–${next[1]} of 400:`));
    from = Number(next[1]);
  }
  assert.ok(pages.length >= 3, `${pages.length} pages`);
  const numbers = pages.flatMap((p) => [...p.matchAll(/^  (\d+)\. \[undefined_terms/gm)].map((m) => Number(m[1])));
  assert.deepEqual(numbers, Array.from({ length: 400 }, (_, i) => i + 1));
  // pageOf on its own: the first item always goes on the page, however long.
  const one = pageOf([{ t: 'y'.repeat(PAGE_CHARS * 2) }, { t: 'z' }], 0, (it) => it.t);
  assert.equal(one.lines.length, 1);
  assert.equal(one.end, 1);
});

test('get_document_checks reads the file now when the Hub stored no check, and refuses with a sentence when it cannot', async () => {
  const { run, supabase } = tools();
  const text = await run('get_document_checks', { versionId: V3 });
  assert.match(text, /^Proof check of Notes v1 \(notes-v1\.txt\), project M6 Motorway: checked now from the file; the Hub had not stored a check for this version\.\nOpen in Hub: https:\/\/hub\.test\/ai\/d\/ffffffff-ffff-4fff-8fff-ffffffffffff\?embed=1&host=pane\n/);
  assert.match(text, /\d+ findings? \(checked \d+ \w+ 20\d\d\): blanks and placeholders [1-9]/);
  assert.match(text, /\[placeholders, \w+\] [^\n]*\[●\]/);
  assert.match(text, /\[End of the findings\.\]$/);
  assert.deepEqual(supabase.downloads, [`${P1}/notes-v1.txt`]);
  // A check the worker gave up on ({ error }, or { skipped } for a scan) is reported as the summary reports it, without reading the file; recheck: true reads it.
  assert.equal(await run('get_document_checks', { versionId: V2 }), `Proof check of Concession Agreement v2 (CA v2.docx), project M6 Motorway (an AI draft): Could not be checked: The file could not be read.\nOpen in Hub: https://hub.test/ai/d/${V2}?embed=1&host=pane\nrecheck: true reads the file now (up to two minutes).`);
  assert.equal(supabase.downloads.length, 1, 'no download for a stored refusal');
  await assert.rejects(run('get_document_checks', { versionId: V2, recheck: true }), /The file for v2 is missing from storage\./);
  assert.equal(supabase.downloads.length, 2);
  assert.equal(notDone({ skipped: 'a scanned PDF' }, 'checked'), 'Not checked: a scanned PDF');
  assert.equal(notDone({ error: 'x' }, 'compared'), 'Could not be compared: x');
  assert.equal(notDone(STORED_CHECK, 'checked'), null);
  assert.equal(notDone(null, 'checked'), null);
  await assert.rejects(run('get_document_checks', { versionId: V5 }), /v3 is not a Word, PDF or text file, so it cannot be checked\./);
  await assert.rejects(run('get_document_checks', { versionId: NOBODY }), /There is no project document version with that id/);
  await assert.rejects(run('get_document_checks', { versionId: 'not-an-id' }), /versionId must be a document version id/);
});

test('an on-demand read past the two-minute deadline answers the preview\'s "takes too long" sentence', async () => {
  let t = 1_000_000;
  const { run } = tools({ now: () => (t += ON_DEMAND_READ_MS + 1) });
  await assert.rejects(run('get_document_checks', { versionId: V3 }), new RegExp(`^Error: ${TOO_LONG_MESSAGE.replace(/[.()]/g, '\\$&')}$`));
  await assert.rejects(run('compare_document_versions', { fromVersionId: V3, toVersionId: V4 }), (err) => err.message === TOO_LONG_MESSAGE);
});

test('compare_document_versions prints the stored comparison when it is of that pair, hiding formatting-only changes unless asked', async () => {
  const { run } = tools();
  const text = await run('compare_document_versions', { fromVersionId: V1, toVersionId: V2 });
  assert.match(text, /^Changes from Concession Agreement v1 \(CA v1\.docx\) to Concession Agreement v2 \(CA v2\.docx\), project M6 Motorway: the comparison the Hub stored when it read the later version\.\nOpen in Hub: https:\/\/hub\.test\/ai\/d\/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\?embed=1&host=pane \(v2\)\nOpen in Hub: https:\/\/hub\.test\/ai\/d\/dddddddd-dddd-4ddd-8ddd-dddddddddddd\?embed=1&host=pane \(v1\)\n/);
  assert.match(text, /2 changed, 1 added, 0 removed, 0 moved \(compared 5 Oct 2026\); 3 shown, 1 formatting-only hidden \(includeFormatting: true lists them\)\./);
  assert.match(text, /By nature: wording 1; numbers dates names 1; clause added 1; formatting only 1\./);
  assert.match(text, /Changes 1–3 of 3:\n  1\. cl\. 2\.1: changed \(numbers dates names\)\n     before: twenty-five \(25\) years\n     after:  thirty \(30\) years\n  2\. cl\. 5: added \(clause added\)\n     after:  New clause on tolling\.\n  3\. cl\. 9: changed \(wording\)\n/);
  assert.doesNotMatch(text, /cl\. 7/);
  assert.match(text, /\[End of the changes\.\]$/);
  const all = await run('compare_document_versions', { fromVersionId: V1, toVersionId: V2, includeFormatting: true });
  assert.match(all, /1 formatting-only listed too\./);
  assert.match(all, /Changes 1–4 of 4:/);
  assert.match(all, /  3\. cl\. 7: changed \(formatting only\) \[spacing\]\n     before: a\n     after:  a/);
  assert.match(await run('compare_document_versions', { fromVersionId: V1, toVersionId: V2, from: 2 }), /Changes 3–3 of 3:\n  3\. cl\. 9/);
  assert.match(await run('compare_document_versions', { fromVersionId: V1, toVersionId: V2, from: 3 }), /There are 3 changes; there is nothing at from: 3\.$/);
  // Only a comparison made against the version asked for counts as stored.
  assert.equal(storedChanges({ changes_from_previous: STORED_CHANGES, compared_with_version_id: V1 }, V1), STORED_CHANGES);
  assert.equal(storedChanges({ changes_from_previous: STORED_CHANGES, compared_with_version_id: null }, V1), STORED_CHANGES, 'the previous block names the pair too');
  assert.equal(storedChanges({ changes_from_previous: STORED_CHANGES, compared_with_version_id: V1 }, V3), null);
  assert.equal(storedChanges({ changes_from_previous: { skipped: 'x' }, compared_with_version_id: V1 }, V1), null);
});

test('compare_document_versions reads both files now for any other pair, and guards the pair', async () => {
  const { run } = tools();
  const text = await run('compare_document_versions', { fromVersionId: V3, toVersionId: V4 });
  assert.match(text, /^Changes from Notes v1 \(notes-v1\.txt\) to Notes v2 \(notes-v2\.txt\), project M6 Motorway: compared now from the two files\.\n/);
  assert.match(text, /\n[1-9]\d* changed, \d+ added, \d+ removed, \d+ moved \(compared \d+ \w+ 20\d\d\); [1-9]\d* shown/);
  assert.match(text, /forty \(40\) years/);
  assert.match(text, /\[End of the changes\.\]$/);
  // Stored as skipped for that pair: the sentence, no read; recheck: true reads now (the earlier file is missing here).
  assert.equal(await run('compare_document_versions', { fromVersionId: V6, toVersionId: V7 }), `Changes from Notes v4 (notes-v4.txt) to Notes v5 (notes-v5.txt), project M6 Motorway: Not compared: not comparable\nOpen in Hub: https://hub.test/ai/d/${V7}?embed=1&host=pane (v5)\nOpen in Hub: https://hub.test/ai/d/${V6}?embed=1&host=pane (v4)\nrecheck: true reads the two files now (up to two minutes).`);
  await assert.rejects(run('compare_document_versions', { fromVersionId: V6, toVersionId: V7, recheck: true }), /The file for v4 is missing from storage\./);
  // The skip was about v4 -> v5; another pair ending in v5 is read now.
  assert.match(await run('compare_document_versions', { fromVersionId: V3, toVersionId: V7 }), /^Changes from Notes v1 \(notes-v1\.txt\) to Notes v5 \(notes-v5\.txt\), project M6 Motorway: compared now from the two files\.\n/);
  await assert.rejects(run('compare_document_versions', { fromVersionId: V3, toVersionId: V5 }), /v3 is not a Word, PDF or text file, so it cannot be compared\./);
  await assert.rejects(run('compare_document_versions', { fromVersionId: V1, toVersionId: V3 }), /Both versions must belong to the same document\./);
  await assert.rejects(run('compare_document_versions', { fromVersionId: V1, toVersionId: V1 }), /Pick two different versions to compare\./);
  await assert.rejects(run('compare_document_versions', { fromVersionId: V1, toVersionId: NOBODY }), /There is no project document version with the toVersionId given/);
  await assert.rejects(run('compare_document_versions', { fromVersionId: 'x', toVersionId: V1 }), /fromVersionId and toVersionId must be document version ids/);
});

test('an on-demand result is kept for the next page, and one on-demand read runs at a time', async () => {
  let t = 1_000_000;
  const { run, supabase } = tools({ now: () => (t += 1000) });
  const first = await run('get_document_checks', { versionId: V3 });
  assert.match(first, /checked now from the file/);
  // Every later page, and a compare of the same pair, comes from memory: no second download.
  await run('get_document_checks', { versionId: V3, from: 1 });
  await run('get_document_checks', { versionId: V3, from: 0 });
  assert.deepEqual(supabase.downloads, [`${P1}/notes-v1.txt`]);
  const cmp = await run('compare_document_versions', { fromVersionId: V3, toVersionId: V4 });
  await run('compare_document_versions', { fromVersionId: V3, toVersionId: V4, from: 1, includeFormatting: true });
  assert.match(cmp, /compared now from the two files/);
  assert.deepEqual(supabase.downloads, [`${P1}/notes-v1.txt`, `${P1}/notes-v1.txt`, `${P1}/notes-v2.txt`], 'the compare read both files once');
  // After RESULT_CACHE_MS the file is read again.
  t += RESULT_CACHE_MS;
  await run('get_document_checks', { versionId: V3 });
  assert.equal(supabase.downloads.length, 4);
  // recheck: true on a stored check reads the file (once), then pages from memory.
  await assert.rejects(run('get_document_checks', { versionId: V1, recheck: true }), /The file for v1 is missing from storage\./);
  assert.equal(supabase.downloads.at(-1), `${P1}/CA v1.docx`);

  // One at a time, per process: a second caller is refused with BUSY while a read is in flight, even through another factory, and never while the first is served from a stored result.
  let release;
  const slow = tools({}, { hold: new Promise((r) => { release = r; }) });
  const other = tools();
  const pending = slow.run('get_document_checks', { versionId: V3 });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(other.run('get_document_checks', { versionId: V4 }), new RegExp(`^Error: ${BUSY.replace(/[.()]/g, '\\$&')}$`));
  await assert.rejects(other.run('compare_document_versions', { fromVersionId: V3, toVersionId: V4 }), /Try again in a moment/);
  assert.match(await other.run('get_document_checks', { versionId: V1 }), /the check the Hub stored/, 'a stored check needs no read');
  release();
  assert.match(await pending, /checked now from the file/);
  // Released after the read, and after a failed one.
  assert.match(await other.run('get_document_checks', { versionId: V4 }), /checked now from the file/);
  await assert.rejects(other.run('get_document_checks', { versionId: V5 }), /cannot be checked/);
  assert.match(await other.run('compare_document_versions', { fromVersionId: V3, toVersionId: V4 }), /compared now from the two files/);
});

test('documentInsight.js answers the preview routes\' results and statuses, and the deadline stops a read', async () => {
  const db = fakeSupabase(fixtures());
  const lines = [];
  const check = await proofCheckVersion(db, V3, { log: (l) => lines.push(l) });
  assert.ok(check.total >= 1 && Array.isArray(check.items) && check.counts.placeholders >= 1);
  assert.match(lines.at(-1), new RegExp(`^proof check v1 \\(${V3}\\): ${check.total} findings$`));
  const cmp = await compareVersionPair(db, V3, V4, { log: (l) => lines.push(l) });
  assert.deepEqual(cmp.previous, { version_id: V3, version_number: 1, file_name: 'notes-v1.txt' });
  assert.ok(cmp.shown >= 1 && Array.isArray(cmp.items));
  assert.match(lines.at(-1), new RegExp(`^compare v1 -> v2 \\(${D2}\\): ${cmp.shown} shown, ${cmp.hidden} hidden$`));
  const status = async (p) => { try { await p; return null; } catch (err) { return err instanceof InsightError ? [err.status, err.message] : err; } };
  assert.deepEqual(await status(proofCheckVersion(db, NOBODY)), [404, 'Document version not found']);
  assert.deepEqual(await status(proofCheckVersion(db, V5)), [422, 'v3 is not a Word, PDF or text file, so it cannot be checked.']);
  assert.deepEqual(await status(proofCheckVersion(db, V2)), [404, 'The file for v2 is missing from storage.']);
  assert.deepEqual(await status(compareVersionPair(db, V1, V1)), [400, 'Pick two different versions to compare.']);
  assert.deepEqual(await status(compareVersionPair(db, V1, V3)), [400, 'Both versions must belong to the same document.']);
  assert.deepEqual(await status(compareVersionPair(db, V3, V5)), [422, 'v3 is not a Word, PDF or text file, so it cannot be compared.']);
  const failing = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'down' } }) }) }) };
  assert.deepEqual(await status(proofCheckVersion(failing, V3)), [500, 'Could not look up the version.']);
  // deadlineStop: a gone client first, then the deadline.
  const gone = new AbortController();
  const stop = deadlineStop({ signal: gone.signal, ms: 10, now: () => 0 });
  stop();
  gone.abort();
  assert.throws(stop, /client gone/);
  let t = 0;
  const late = deadlineStop({ ms: 10, now: () => (t += 11) });
  assert.throws(late, (err) => err.tooLong === true);
  await assert.rejects(proofCheckVersion(db, V3, { checkStop: late }), (err) => err.tooLong === true);
});

test('server.js uses the lifted functions and no longer carries the body itself', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ ON_DEMAND_READ_MS, TOO_LONG_MESSAGE, deadlineStop, proofCheckVersion, compareVersionPair \} from "\.\/documentInsight\.js";/);
  assert.match(src, /compare \? await compareVersionPair\(db, ids\[0\], ids\[1\], options\) : await proofCheckVersion\(db, ids\[0\], options\)/);
  assert.match(src, /if \(err\?\.status\) return json\(err\.status, \{ error: err\.message \}\);/);
  assert.match(src, /if \(err\?\.tooLong\) return json\(422, \{ error: TOO_LONG_MESSAGE \}\);/);
  assert.doesNotMatch(src, /runProofCheck|readForCompare|compareVersions\(|COMPARABLE_EXTENSIONS/);
});
