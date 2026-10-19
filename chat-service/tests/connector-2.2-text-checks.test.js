// Piece 2.2: check_text and compare_text_with_version
// (connector/tools/textChecks.js) against a stubbed database: the Hub's
// proof check on text claude.ai wrote, and a clause-by-clause comparison of
// that text against a stored version, both read-only, model-free and
// paged as get_document_checks and compare_document_versions are. The text
// is read as the worker reads a saved Markdown file; the version's file is
// read as documentInsight.js reads one, one at a time, under the deadline,
// and kept for the next page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES, MAX_RESULT_CHARS } from '../connector/tools.js';
import { READ_ONLY } from '../connector/app.js';
import textChecks, { readText, MAX_TEXT_CHARS, MAX_WORD_CHARS, TEXT_FILE_NAME, EMPTY_TEXT, TOO_LONG_TEXT, LONG_WORD, NO_WORDS } from '../connector/tools/textChecks.js';
import { PAGE_CHARS, BUSY, RESULT_CACHE_MS } from '../connector/tools/documentInsight.js';
import { ON_DEMAND_READ_MS, TOO_LONG_MESSAGE } from '../documentInsight.js';
import { readForCompare } from '../versionCompare.js';

const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D2 = '99999999-9999-4999-8999-999999999999';
const V2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const V3 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const V4 = '12121212-1212-4121-8121-121212121212';
const V5 = '34343434-3434-4343-8343-343434343434';
const NOBODY = '00000000-0000-4000-8000-000000000000';

// A Supabase client over plain arrays, as connector-1.3-checks-compare.test.js
// has it. Every file download is counted in `downloads`; `hold` (a promise)
// is awaited before each one, to make a read slow.
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
const version = (id, md, n, file, extra = {}) => ({ id, version_number: n, file_name: file, storage_path: `${P1}/${file}`, matter_document_id: md.id, matter_document: md, is_ai_generated: false, created_at: '2026-10-01T08:00:00Z', indexing_status: 'indexed', ...extra });

const NOTES_V1 = '1. Definitions\n\n1.1 "Term" means thirty (31) years from the Effective Date.\n\n2. Payment\n\n2.1 The Fee is [●] and the Toll Notification applies.\n\n3. Term\n\n3.1 This Agreement runs for the Term.';
// Claude's redraft of NOTES_V1: two clauses changed.
const REDRAFT = '1. Definitions\n\n1.1 "Term" means forty (40) years from the Effective Date.\n\n2. Payment\n\n2.1 The Fee is PKR 100 and the Toll Notification applies.\n\n3. Term\n\n3.1 This Agreement runs for the Term.';
// A draft with one of each of five slips.
const DRAFT = '# Concession Agreement\n\n## 1. Definitions\n\n1.1 "Term" means thirty (31) years from the Effective Date.\n\n1.2 "Concessionaire" means [●].\n\n## 2. Payment\n\n2.1 The Fee is [insert amount] and the Toll Notification applies, as set out in Schedule 9.\n\n## 4. Term\n\n4.1 This Agreement runs for the Term, subject to clause 17.3.';

function fixtures() {
  return {
    tables: {
      document_versions: [
        version(V2, md1, 2, 'CA v2.docx', { is_ai_generated: true }),
        version(V3, md2, 1, 'notes-v1.txt'),
        version(V4, md2, 2, 'notes-v2.txt', { indexing_status: 'pending' }),
        version(V5, md2, 3, 'notes-v3.xlsx'),
      ],
    },
    files: {
      [`matter-documents/${P1}/notes-v1.txt`]: NOTES_V1,
      [`matter-documents/${P1}/notes-v2.txt`]: REDRAFT,
    },
  };
}

function tools(extra = {}, fake = {}) {
  const f = fixtures();
  const supabase = fakeSupabase({ ...f, ...fake });
  const list = createHubTools({ supabase, voyageKey: 'v', log: () => {}, hubUrl: 'https://hub.test', modules: [textChecks], ...extra });
  const byName = Object.fromEntries(list.map((t) => [t.name, t]));
  return { ...f, supabase, list, byName, run: (name, input) => byName[name].run(input, { userId: 'u1', scope: 'hub:read' }) };
}

test('the two tools register from connector/tools/textChecks.js after the built-in eight, read-only in shape, and say what they are for', async () => {
  const modules = await loadToolModules();
  assert.ok(modules.some((m) => m.file === 'textChecks.js'));
  const { list } = tools({ modules });
  const names = list.map((t) => t.name);
  assert.deepEqual(names.slice(0, BUILT_IN_TOOL_NAMES.length), [...BUILT_IN_TOOL_NAMES]);
  assert.ok(names.includes('check_text') && names.includes('compare_text_with_version'));
  assert.equal(new Set(names).size, names.length, 'no name twice');
  // File order: textChecks.js loads after standards.js, so its two come last.
  assert.deepEqual(names.slice(-2), ['check_text', 'compare_text_with_version']);
  for (const name of ['check_text', 'compare_text_with_version']) {
    const t = list.find((x) => x.name === name);
    assert.ok(t.title && t.description.length > 120, `${name} tells a lawyer's Claude what it is for`);
    assert.equal(t.write, undefined, `${name} is not a write tool`);
    assert.equal(t.annotations, READ_ONLY, `${name} says it is read-only`);
    assert.equal(t.annotations.readOnlyHint, true);
    assert.ok(t.inputSchema.text, `${name} takes the text`);
    assert.ok(t.inputSchema.from, `${name} pages with from`);
    assert.match(t.description, /nothing is saved/i, `${name} says it saves nothing`);
    assert.match(t.description, /300,000 characters/);
  }
  const cmp = list.find((x) => x.name === 'compare_text_with_version');
  assert.ok(cmp.inputSchema.versionId && cmp.inputSchema.includeFormatting);
  assert.match(cmp.description, /one such read at a time/);
  assert.match(list.find((x) => x.name === 'check_text').description, /get_document_checks/, 'the same check as the stored one');
  // A read-only sign-in runs them: the wrapper refuses only write tools.
  const { run } = tools();
  assert.match(await run('check_text', { text: 'A short note with nothing wrong in it.' }), /^Proof check of the text given/);
});

test('check_text runs the proof check on the text: counts, every finding numbered with its clause, and the end of the list', async () => {
  const { run, supabase } = tools();
  const text = await run('check_text', { text: DRAFT });
  assert.match(text, /^Proof check of the text given \(\d{3} characters, 8 paragraphs\): checked now, without a model; nothing was saved\.\n5 findings: blanks and placeholders 2; terms used but not defined 0; definitions never used 1; cross-references to nothing 1; numbers whose words and figures disagree 1; gaps in numbering 0\.\n\nFindings 1–5 of 5:\n/);
  assert.match(text, /  1\. \[placeholders, medium\] Clause 1\.2: 1\.2 "Concessionaire" means \[●\]\. — A blank still to be filled in\./);
  assert.match(text, /  2\. \[placeholders, medium\] Clause 2\.1: [^\n]*\[insert amount\][^\n]* — A bracketed field still to be filled in\./);
  assert.match(text, /  3\. \[unused_definitions, low\] Clause 1\.2: [^\n]*“Concessionaire” is defined but not used anywhere else/);
  assert.match(text, /  4\. \[broken_references, high\] Clause 4\.1: [^\n]*Refers to Clause 17\.3, but this document has no Clause 17\.3\./);
  assert.match(text, /  5\. \[number_words, high\] Clause 1\.1: [^\n]*The words say 30 but the figure says 31\./);
  assert.match(text, /\n\n\[End of the findings\.\]$/);
  assert.doesNotMatch(text, /Open in Hub/, 'nothing in the Hub to open: the text is not filed');
  assert.deepEqual(supabase.downloads, [], 'no file is read');
  // Past the end.
  assert.equal(await run('check_text', { text: DRAFT, from: 5 }), `${text.split('\n')[0]}\nThere are 5 findings; there is nothing at from: 5.`);
  // A clean draft: the counts line and nothing else.
  const clean = await run('check_text', { text: '1. Term\n\n1.1 This Agreement runs for five (5) years.' });
  assert.match(clean, /^Proof check of the text given \(\d+ characters, 2 paragraphs\): checked now, without a model; nothing was saved\.\n0 findings: blanks and placeholders 0; [^\n]*gaps in numbering 0\.$/);
  // Markdown is read as the worker reads a saved .md: "#" headings are headings, not clauses.
  const read = await readText('# Heading\n\n1.1 A clause.');
  assert.equal(read.format, 'md');
  assert.deepEqual(read.blocks[0], { text: '# Heading', heading: { depth: 1, entry: 'Heading' } });
  assert.equal(TEXT_FILE_NAME, 'draft.md');
  assert.deepEqual(read.blocks, (await readForCompare(new TextEncoder().encode('# Heading\n\n1.1 A clause.'), TEXT_FILE_NAME)).blocks);
});

test('a long check is paged: every page fits under the cap uncut, numbering runs on, the last page says so, and what was not kept is counted', async () => {
  const filler = 'and the Concessionaire shall in each case give the Authority not less than thirty (30) days written notice of the amount payable together with such supporting documents as the Authority may reasonably require for the purpose of verifying it';
  const long = Array.from({ length: 300 }, (_, i) => `${i + 1}. The Project Company shall pay [insert amount ${i + 1}] to the Authority on the Payment Date ${filler}.`).join('\n\n');
  assert.ok(long.length < MAX_TEXT_CHARS);
  const { run } = tools();
  const pages = [];
  let from = 0;
  for (;;) {
    const page = await run('check_text', { text: long, from });
    pages.push(page);
    assert.ok(page.length <= PAGE_CHARS + 1000 && page.length <= MAX_RESULT_CHARS, `page of ${page.length} chars`);
    assert.doesNotMatch(page, /\[Cut here:/);
    assert.match(page, /^Proof check of the text given \([\d,]+ characters, 300 paragraphs\)/);
    assert.match(page, /\n300 findings: blanks and placeholders 300;/);
    assert.match(page, /\nNot listed \(the check keeps at most 100 findings in a category\): 200 more under blanks and placeholders\.\n/);
    const next = /call check_text again with the same text and from: (\d+)\.\]$/.exec(page);
    if (!next) { assert.match(page, /\[End of the findings\.\]$/); break; }
    assert.match(page, new RegExp(`Findings ${from + 1}–${next[1]} of 100:`));
    from = Number(next[1]);
  }
  assert.ok(pages.length >= 2, `${pages.length} pages`);
  const numbers = pages.flatMap((p) => [...p.matchAll(/^  (\d+)\. \[placeholders/gm)].map((m) => Number(m[1])));
  assert.deepEqual(numbers, Array.from({ length: 100 }, (_, i) => i + 1));
});

test('check_text refuses bad input with one sentence before reading anything', async () => {
  const { run } = tools();
  await assert.rejects(run('check_text', {}), new RegExp(`^Error: ${EMPTY_TEXT.replace(/[.()]/g, '\\$&')}$`));
  await assert.rejects(run('check_text', { text: '   \n ' }), new RegExp(EMPTY_TEXT.slice(0, 30)));
  await assert.rejects(run('check_text', { text: 42 }), new RegExp(EMPTY_TEXT.slice(0, 30)));
  await assert.rejects(run('check_text', { text: 'word '.repeat(MAX_TEXT_CHARS / 5) + 'x' }), new RegExp(`^Error: ${TOO_LONG_TEXT.replace(/[.()]/g, '\\$&')}$`));
  assert.match(TOO_LONG_TEXT, /300,000 characters/);
  // Exactly the cap is read, in well under a second.
  const started = Date.now();
  assert.match(await run('check_text', { text: 'word '.repeat(MAX_TEXT_CHARS / 5) }), /^Proof check of the text given \(300,000 characters, 1 paragraph\)/);
  assert.ok(Date.now() - started < 5000, 'a long text of words is quick');
  // One unbroken run longer than MAX_WORD_CHARS (the check's time is quadratic in it) is refused, not run.
  await assert.rejects(run('check_text', { text: `1.1 The key is ${'x'.repeat(MAX_WORD_CHARS + 1)} for the Term.` }), new RegExp(`^Error: ${LONG_WORD.replace(/[.()]/g, '\\$&')}$`));
  await assert.rejects(run('compare_text_with_version', { versionId: V3, text: 'x'.repeat(MAX_WORD_CHARS + 1) }), new RegExp(LONG_WORD.slice(0, 30)));
  assert.match(LONG_WORD, /5,000 characters/);
  assert.match(await run('check_text', { text: `1.1 The key is ${'x'.repeat(MAX_WORD_CHARS)} for the Term.` }), /^Proof check of the text given/, 'a run of exactly the limit is read');
  await assert.rejects(readText(''), new RegExp(EMPTY_TEXT.slice(0, 30)));
  assert.equal(typeof NO_WORDS, 'string');
});

test('compare_text_with_version reads the version now and prints what the text changes against it, with the Hub link, paged', async () => {
  const { run, supabase } = tools();
  const text = await run('compare_text_with_version', { versionId: V3, text: REDRAFT });
  assert.match(text, /^Changes from Notes v1 \(notes-v1\.txt\), project M6 Motorway, to the text given \(\d{3} characters\): compared now, without a model; nothing was saved\.\nOpen in Hub: https:\/\/hub\.test\/ai\/d\/ffffffff-ffff-4fff-8fff-ffffffffffff \(v1\)\n\n2 changed, 0 added, 0 removed, 0 moved; 2 shown, 0 formatting-only hidden \(includeFormatting: true lists them\)\.\nBy nature: numbers dates names 2\.\n\nChanges 1–2 of 2:\n/);
  assert.match(text, /  1\. Clause 1\.1: changed \(numbers dates names\)\n     before: 1\.1 "Term" means thirty \(31\) years from the Effective Date\.\n     after:  1\.1 "Term" means forty \(40\) years from the Effective Date\.\n/);
  assert.match(text, /  2\. Clause 2\.1: changed \(numbers dates names\)\n     before: 2\.1 The Fee is \[●\] and the Toll Notification applies\.\n     after:  2\.1 The Fee is PKR 100 and the Toll Notification applies\.\n\n\[End of the changes\.\]$/);
  assert.deepEqual(supabase.downloads, [`${P1}/notes-v1.txt`]);
  // Later pages, and a second redraft against the same version, come from the kept reading: no second download.
  assert.match(await run('compare_text_with_version', { versionId: V3, text: REDRAFT, from: 1 }), /\n\nChanges 2–2 of 2:\n  2\. Clause 2\.1/);
  assert.match(await run('compare_text_with_version', { versionId: V3, text: REDRAFT, from: 2 }), /^Changes from Notes v1[^\n]*\nThere are 2 changes; there is nothing at from: 2\.$/);
  assert.match(await run('compare_text_with_version', { versionId: V3, text: REDRAFT, includeFormatting: true }), /0 formatting-only listed too\./);
  // The same text as the version: no change.
  assert.match(await run('compare_text_with_version', { versionId: V3, text: NOTES_V1 }), /^Changes from Notes v1[^\n]*\nOpen in Hub: [^\n]*\n\nNo change in the text: the text given reads the same as Notes v1 \(notes-v1\.txt\)\.$/);
  assert.deepEqual(supabase.downloads, [`${P1}/notes-v1.txt`], 'the version was read once');
  // Another version is its own read; an AI draft is said to be one.
  const v2 = await run('compare_text_with_version', { versionId: V4, text: NOTES_V1 });
  assert.match(v2, /^Changes from Notes v2 \(notes-v2\.txt\), project M6 Motorway, to the text given/);
  assert.match(v2, /after:  1\.1 "Term" means thirty \(31\) years/);
  assert.deepEqual(supabase.downloads, [`${P1}/notes-v1.txt`, `${P1}/notes-v2.txt`]);
});

test('compare_text_with_version refuses with one sentence: a bad or missing version, a file it cannot read, bad text, a read past the deadline', async () => {
  const { run, supabase } = tools();
  await assert.rejects(run('compare_text_with_version', { versionId: 'not-an-id', text: REDRAFT }), /versionId must be a document version id/);
  await assert.rejects(run('compare_text_with_version', { versionId: NOBODY, text: REDRAFT }), /There is no project document version with that id/);
  await assert.rejects(run('compare_text_with_version', { versionId: V5, text: REDRAFT }), /^Error: v3 is not a Word, PDF or text file, so it cannot be compared\.$/);
  await assert.rejects(run('compare_text_with_version', { versionId: V2, text: REDRAFT }), /^Error: The file for v2 is missing from storage\.$/);
  assert.deepEqual(supabase.downloads, [`${P1}/CA v2.docx`], 'a spreadsheet is refused before any download');
  // Bad text is refused before the file is read.
  await assert.rejects(run('compare_text_with_version', { versionId: V3 }), new RegExp(EMPTY_TEXT.slice(0, 30)));
  await assert.rejects(run('compare_text_with_version', { versionId: V3, text: 'x'.repeat(MAX_TEXT_CHARS + 1) }), new RegExp(TOO_LONG_TEXT.slice(0, 30)));
  assert.equal(supabase.downloads.length, 1);
  // Past the two-minute deadline: the preview's sentence.
  let t = 1_000_000;
  const late = tools({ now: () => (t += ON_DEMAND_READ_MS + 1) });
  await assert.rejects(late.run('compare_text_with_version', { versionId: V3, text: REDRAFT }), (err) => err.message === TOO_LONG_MESSAGE);
  // After RESULT_CACHE_MS the file is read again.
  let u = 1_000_000;
  const aged = tools({ now: () => (u += 1000) });
  await aged.run('compare_text_with_version', { versionId: V3, text: REDRAFT });
  await aged.run('compare_text_with_version', { versionId: V3, text: REDRAFT, from: 1 });
  assert.equal(aged.supabase.downloads.length, 1);
  u += RESULT_CACHE_MS;
  await aged.run('compare_text_with_version', { versionId: V3, text: REDRAFT });
  assert.equal(aged.supabase.downloads.length, 2);
});

test('one file read runs at a time: a second caller is told to try again while one is in flight, and served after', async () => {
  let release;
  const slow = tools({}, { hold: new Promise((r) => { release = r; }) });
  const other = tools();
  const pending = slow.run('compare_text_with_version', { versionId: V3, text: REDRAFT });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(other.run('compare_text_with_version', { versionId: V4, text: NOTES_V1 }), new RegExp(`^Error: ${BUSY.replace(/[.()]/g, '\\$&')}$`));
  assert.match(await other.run('check_text', { text: DRAFT }), /^Proof check of the text given/, 'a check reads no file, so it is never held up');
  release();
  assert.match(await pending, /2 changed, 0 added/);
  // Released after the read, and after a failed one.
  assert.match(await other.run('compare_text_with_version', { versionId: V4, text: NOTES_V1 }), /^Changes from Notes v2/);
  await assert.rejects(other.run('compare_text_with_version', { versionId: V2, text: NOTES_V1 }), /missing from storage/);
  assert.match(await other.run('compare_text_with_version', { versionId: V3, text: REDRAFT }), /2 changed, 0 added/);
});
