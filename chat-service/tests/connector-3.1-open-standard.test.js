// open_standard_for_filling (connector/tools/fillStandard.js): the firm's
// Word standard opened for a fill from claude.ai. The standard is a small
// real .docx built here (a heading, blanks in the body, a table cell and a
// header); the database and the storage bucket are stubbed. The reply is
// checked against docxAgent's own placeholder view, the Hub's fill
// instructions (firmRules.js, which server.js now prompts with) and the ops
// protocol; the twenty-minute cache, the paging with `from`, and the
// refusals are each exercised. A standard too long for the Hub's own
// 120,000-character placeholder view (the Concession Agreement is one)
// shows that every blank is still listed here, that each gap names the
// paragraphs it hides, and that `paragraphs: "from-to"` reads them with
// the ¶ numbers the fill tool resolves against.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES, MAX_RESULT_CHARS } from '../connector/tools.js';
import { DEFAULT_HUB_URL } from '../connector/hubLinks.js';
import fillStandard, { createStandardLoader, clearStandardCache, pageOfListing, fillListing, blankCounts, parseRange, rangeListing, standardRows, CONNECTOR_FILL_NOTE, STANDARD_CACHE_MS, BUCKET, MAX_RANGE } from '../connector/tools/fillStandard.js';
import { inspectDocx, OPS_PROTOCOL, MAX_LISTING_CHARS } from '../docxAgent.js';
import { FILL_INSTRUCTIONS, FILL_DIRECT_NOTE } from '../firmRules.js';

const T_CA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T_LONG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T_TEXT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T_NONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const T_BROKEN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const T_MISSING = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const T_BIG = '99999999-9999-4999-8999-999999999991';
const SNAP = '11111111-1111-4111-8111-111111111111';

const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const STYLES = `<w:styles ${ns}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`;

/** A Word file: a heading, a recital with two blanks, plain text, a cell with a blank, a header with one. */
function standardDocx(body, extra = {}) {
  return zipSync({
    'word/document.xml': strToU8(`<w:document ${ns}><w:body>${body}<w:sectPr/></w:body></w:document>`),
    'word/styles.xml': strToU8(STYLES),
    'word/header1.xml': strToU8(`<w:hdr ${ns}>${p('[Project Name] — Concession Agreement')}</w:hdr>`),
    ...extra,
  }, { mtime: new Date(Date.UTC(2026, 0, 1)) });
}
const SMALL_BODY = p('CONCESSION AGREEMENT', 'Heading1')
  + p('This Agreement is made on [●] between the Government of Sindh (the Authority) and [●] (the Concessionaire).')
  + p('WHEREAS the Authority wishes to procure the Project on a build-operate-transfer basis.')
  + p('The Concession Period is thirty (30) years from the Effective Date.')
  + `<w:tbl><w:tr><w:tc>${p('Project Site: ____ hectares at [●].')}</w:tc></w:tr></w:tbl>`;
const SMALL = standardDocx(SMALL_BODY);
// Four hundred clauses, each with a blank, so the placeholder listing runs to several pages.
const LONG = standardDocx(p('LONG STANDARD', 'Heading1') + Array.from({ length: 400 }, (_, i) => p(`${i + 1}. The Concessionaire shall pay the Authority PKR [●] on the ${i + 1}th day of each month, being the Concession Fee for Project Facility [name of facility ${i + 1}] under this Agreement.`)).join(''));
// The shape of the real Concession Agreement standard, which the Hub's
// placeholder view cannot hold whole: three thousand clauses of plain text
// with a blank in every tenth, a heading every two hundred, and ninety
// "[Drafting Note]" footnotes.
const BIG_CLAUSE = (i) => `${i}. The Concessionaire shall, at its own cost and expense, design, finance, construct, operate and maintain the Project Facilities in accordance with the Specifications, Good Industry Practice and Applicable Law throughout the Concession Period, and shall indemnify the Authority accordingly.`;
const BIG_BODY = Array.from({ length: 3000 }, (_, k) => {
  const i = k + 1;
  if (i % 200 === 1) return p(`ARTICLE ${Math.ceil(i / 200)} — OBLIGATIONS`, 'Heading1');
  if (i % 10 === 0) return p(`${i}. The Concessionaire shall pay the Authority PKR [●] on the [●] day of each month for Facility [name of facility ${i}].`);
  return p(BIG_CLAUSE(i));
}).join('');
const BIG_NOTES = `<w:footnotes ${ns}>${Array.from({ length: 90 }, (_, k) => `<w:footnote w:id="${k + 1}">${p(`[Drafting Note] Insert the figure the term sheet gives for item ${k + 1}; delete this note before circulation.`)}</w:footnote>`).join('')}</w:footnotes>`;
const BIG = standardDocx(BIG_BODY, { 'word/footnotes.xml': strToU8(BIG_NOTES) });
const PH = /\[[^\]\n]{0,120}\]|_{3,}/;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A Supabase client over plain rows, with a storage bucket of byte arrays; counts downloads. */
function fakeSupabase(tables, files) {
  const downloads = [];
  const selected = [];
  const chain = (table) => {
    let rows = [...(tables[table] ?? [])];
    let single = false;
    const q = {
      select(cols) { selected.push({ table, cols }); return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      maybeSingle() { single = true; return q; },
      then(ok, bad) { return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(ok, bad); },
    };
    return q;
  };
  return {
    downloads,
    selected,
    from: chain,
    storage: {
      from(bucket) {
        assert.equal(bucket, BUCKET);
        return {
          async download(path) {
            downloads.push(path);
            const bytes = files[path];
            if (!bytes) return { data: null, error: { message: 'Object not found' } };
            return { data: new Blob([bytes]), error: null };
          },
        };
      },
    },
  };
}

function fixtures() {
  const types = [
    { id: T_CA, name: 'Concession Agreement', category: 'Infrastructure', questionnaire: null },
    { id: T_LONG, name: 'Long Standard', category: 'Infrastructure', questionnaire: 'rfp_federal_ppp' },
    { id: T_TEXT, name: 'Seeded Agreement', category: 'Corporate', questionnaire: null },
    { id: T_NONE, name: 'Board Resolution', category: 'Corporate', questionnaire: null },
    { id: T_BROKEN, name: 'Broken Standard', category: 'Corporate', questionnaire: null },
    { id: T_MISSING, name: 'Missing File', category: 'Corporate', questionnaire: null },
    { id: T_BIG, name: 'Big Standard', category: 'Infrastructure', questionnaire: null },
  ];
  const templates = [
    { document_type_id: T_CA, filename: 'Standard Concession Agreement [AKLA].docx', storage_path: `standards/${T_CA}/1-CA.docx`, updated_at: '2026-10-01T08:00:00Z', content_html: 'text', format_rules: 'Clauses are numbered 1, 1.1, 1.1.1; body Arial 11.' },
    { document_type_id: T_LONG, filename: 'Long.docx', storage_path: `standards/${T_LONG}/1-Long.docx`, updated_at: '2026-10-02T08:00:00Z', content_html: 'text', format_rules: null },
    { document_type_id: T_TEXT, filename: null, storage_path: null, updated_at: '2026-08-28T08:00:00Z', content_html: '<p>Seeded</p>', format_rules: null },
    { document_type_id: T_BROKEN, filename: 'Broken.docx', storage_path: `standards/${T_BROKEN}/1-Broken.docx`, updated_at: '2026-10-03T08:00:00Z', content_html: '', format_rules: null },
    { document_type_id: T_MISSING, filename: 'Gone.docx', storage_path: `standards/${T_MISSING}/1-Gone.docx`, updated_at: '2026-10-03T08:00:00Z', content_html: '', format_rules: null },
    { document_type_id: T_BIG, filename: 'Big.docx', storage_path: `standards/${T_BIG}/1-Big.docx`, updated_at: '2026-10-04T08:00:00Z', content_html: '<p>' + 'x'.repeat(2_000_000) + '</p>', format_rules: null },
  ];
  const snapshots = [{ id: SNAP, document_type_id: T_CA, storage_path: `standards/${T_CA}/1-CA.docx`, filename: 'Standard Concession Agreement [AKLA].docx', created_at: '2026-10-01T08:00:01Z' }];
  const files = {
    [`standards/${T_CA}/1-CA.docx`]: SMALL,
    [`standards/${T_LONG}/1-Long.docx`]: LONG,
    [`standards/${T_BROKEN}/1-Broken.docx`]: zipSync({ 'readme.txt': strToU8('not a word file') }),
    [`standards/${T_BIG}/1-Big.docx`]: BIG,
  };
  return { tables: { document_types: types, document_type_templates: templates, document_template_versions: snapshots }, files };
}

function tools(extra = {}) {
  clearStandardCache();
  const f = fixtures();
  const supabase = fakeSupabase(f.tables, f.files);
  const list = createHubTools({ supabase, voyageKey: 'v', log: () => {}, modules: [fillStandard], ...extra });
  const byName = Object.fromEntries(list.map((t) => [t.name, t]));
  return { supabase, fixtures: f, list, byName, run: (name, input) => byName[name].run(input, { userId: 'u1' }) };
}

test('open_standard_for_filling registers after the built-in eight as a read tool, through the directory and on its own', async () => {
  const { list } = tools();
  assert.deepEqual(list.map((t) => t.name), [...BUILT_IN_TOOL_NAMES, 'open_standard_for_filling']);
  const tool = list.at(-1);
  assert.ok(tool.title && tool.description.length > 80, 'describes itself for a lawyer\'s Claude');
  assert.ok(tool.inputSchema.documentTypeId && tool.inputSchema.from && tool.inputSchema.paragraphs, 'takes documentTypeId, from and paragraphs');
  assert.notEqual(tool.write, true, 'reads only');
  assert.equal(tool.annotations, undefined, 'no annotations: app.js marks it read-only');
  const loaded = await loadToolModules();
  assert.ok(loaded.some((m) => m.file === 'fillStandard.js'), 'connector.js loads it with the rest');
  // The factory touches nothing at startup.
  const names = createHubTools({ supabase: { from() { throw new Error('no db'); } }, voyageKey: 'v', log: () => {}, modules: [fillStandard] }).map((t) => t.name);
  assert.ok(names.includes('open_standard_for_filling'));
});

test('the first page is the Hub\'s own placeholder view, with the fill instructions, the protocol and the file\'s hash', async () => {
  const { run, supabase } = tools();
  const out = await run('open_standard_for_filling', { documentTypeId: T_CA });
  assert.ok(out.length < MAX_RESULT_CHARS);
  assert.deepEqual(supabase.downloads, [`standards/${T_CA}/1-CA.docx`], 'read from precedent-library at the template\'s path');
  assert.match(out, /^Concession Agreement: the firm's Word standard Standard Concession Agreement \[AKLA\]\.docx, as stored 1 Oct 2026 — 6 paragraphs, 3 of them with a blank to fill, every one listed with its ¶ number\. All 6 paragraphs are listed\.\n/);
  assert.ok(!out.includes('drafting notes in the footnotes'), 'no footnotes here');
  assert.ok(supabase.selected.every((s) => s.table !== 'document_type_templates' || !/content_html/.test(s.cols)), 'content_html (the whole standard as HTML) is never pulled');
  assert.ok(out.includes(`templateHash: ${sha(SMALL)}`), 'the sha256 of the bytes as stored, for the fill tool to echo');
  assert.ok(out.includes(`Standard snapshot: ${SNAP} (filed 1 Oct 2026)`), 'the pinned document_template_versions row');
  assert.ok(out.includes(`Open in Hub: ${DEFAULT_HUB_URL}/precedent-library/standardize/${T_CA}`));
  // The very words server.js prompts with, then the format rules, the protocol and the connector's own note.
  assert.ok(out.includes(`FILL INSTRUCTIONS (the Hub's own, for a draft from this standard):\n${FILL_INSTRUCTIONS}\n\nHow the standard is formatted: Clauses are numbered 1, 1.1, 1.1.1; body Arial 11.`));
  assert.ok(out.includes(OPS_PROTOCOL));
  assert.ok(out.includes(FILL_DIRECT_NOTE));
  assert.ok(out.includes(CONNECTOR_FILL_NOTE));
  assert.ok(out.indexOf(FILL_INSTRUCTIONS) < out.indexOf(OPS_PROTOCOL) && out.indexOf(OPS_PROTOCOL) < out.indexOf(FILL_DIRECT_NOTE) && out.indexOf(FILL_DIRECT_NOTE) < out.indexOf(CONNECTOR_FILL_NOTE));
  assert.match(CONNECTOR_FILL_NOTE, /fill_standard_to_project/);
  assert.doesNotMatch(out, /This type has a drafting questionnaire/, 'this type has no questionnaire');
  assert.match(CONNECTOR_FILL_NOTE, /ask the lawyer each decision in prose, one at a time/);
  assert.match(CONNECTOR_FILL_NOTE, /paragraphs set to a range such as "100-140"/);
  assert.match(CONNECTOR_FILL_NOTE, /from pages this listing only and never reaches a hidden paragraph/);
  assert.ok(!/from set to the offset/.test(CONNECTOR_FILL_NOTE), 'the false claim is gone');
  // The listing is the Hub's own placeholder view where that view fits whole: ¶ numbers, the heading, the cell, the header part.
  const view = inspectDocx(SMALL, { placeholders: true });
  assert.equal(fillListing(inspectDocx(SMALL, { budget: Infinity })).listing, view.listing, 'composed from the full view, the same words as the Hub shows');
  assert.ok(out.endsWith(`PARAGRAPHS (characters 1–${view.listing.length} of ${view.listing.length}):\n${view.listing}\n\n[End of the listing.]`));
  assert.match(out, /\n¶1 \[H1\] CONCESSION AGREEMENT\n/);
  assert.match(out, /\n¶2 This Agreement is made on \[●\] between the Government of Sindh \(the Authority\) and \[●\] \(the Concessionaire\)\.\n/);
  assert.match(out, /\n¶5 \[table\] Project Site: ____ hectares at \[●\]\.\n/);
  assert.match(out, /\nPART: word\/header1\.xml\n¶6 \[Project Name\] — Concession Agreement\n/);
  assert.deepEqual(blankCounts(view), { body: 3, notes: 0 });
});

test('the bytes are kept twenty minutes per storage path; a replaced standard is read afresh and has a new hash', async () => {
  let clock = 1_000_000;
  const { run, supabase, fixtures: f } = tools({ now: () => clock });
  const first = await run('open_standard_for_filling', { documentTypeId: T_CA });
  await run('open_standard_for_filling', { documentTypeId: T_CA, from: 0 });
  assert.equal(supabase.downloads.length, 1, 'the second call is served from memory');
  clock += STANDARD_CACHE_MS - 1;
  await run('open_standard_for_filling', { documentTypeId: T_CA });
  assert.equal(supabase.downloads.length, 1, 'still within twenty minutes');
  clock += 1;
  await run('open_standard_for_filling', { documentTypeId: T_CA });
  assert.equal(supabase.downloads.length, 2, 'read again after twenty minutes');
  // The admin replaces the standard: a new path (document_template_versions.storage_path is unique) and a different file.
  const replaced = standardDocx(SMALL_BODY + p('A clause added to the standard: [●].'));
  const t = f.tables.document_type_templates.find((r) => r.document_type_id === T_CA);
  t.storage_path = `standards/${T_CA}/2-CA.docx`;
  f.files[t.storage_path] = replaced;
  const after = await run('open_standard_for_filling', { documentTypeId: T_CA });
  assert.equal(supabase.downloads.at(-1), `standards/${T_CA}/2-CA.docx`);
  assert.ok(after.includes(`templateHash: ${sha(replaced)}`) && !after.includes(sha(SMALL)), 'the fill tool\'s echo of the old hash would be refused');
  assert.ok(first.includes(sha(SMALL)));
  assert.match(after, /Standard snapshot: none recorded for this file\./);
  assert.match(after, /7 paragraphs, 4 of them with a blank/);
});

test('a long standard is paged with from, cut at a line, the pages rebuilding the listing exactly', async () => {
  const { run } = tools();
  const view = fillListing(inspectDocx(LONG, { budget: Infinity }));
  assert.equal(view.listing, inspectDocx(LONG, { placeholders: true }).listing, 'within the Hub\'s budget the two views are the same');
  assert.ok(view.listing.length > MAX_RESULT_CHARS * 2, 'the fixture needs several pages');
  const pages = [];
  let from = 0;
  for (let i = 0; i < 20; i++) {
    const out = await run('open_standard_for_filling', { documentTypeId: T_LONG, from });
    assert.ok(out.length < MAX_RESULT_CHARS, `page ${i + 1} is under the cap (${out.length})`);
    assert.doesNotMatch(out, /\[Cut here:/, 'never clipped by the wrapper');
    assert.ok(out.includes(`templateHash: ${sha(LONG)}`), 'every page carries the hash');
    const body = /\nPARAGRAPHS \(characters ([\d,]+)–([\d,]+) of ([\d,]+)\):\n([\s\S]*)\n\n\[(.*)\]$/.exec(out);
    assert.ok(body, `page ${i + 1} has a PARAGRAPHS section`);
    assert.equal(Number(body[1].replace(/,/g, '')), from + 1);
    pages.push(body[4]);
    if (i === 0) {
      assert.ok(out.includes(OPS_PROTOCOL) && out.includes(FILL_INSTRUCTIONS) && out.includes(CONNECTOR_FILL_NOTE), 'the first page carries the instructions');
      assert.match(out, /This type has a drafting questionnaire: before any fill, call get_drafting_decisions and ask the lawyer each decision in prose, one at a time/);
    } else {
      assert.ok(!out.includes(OPS_PROTOCOL) && !out.includes(FILL_INSTRUCTIONS), 'later pages do not repeat them');
      assert.match(out, /The fill instructions and the operations protocol are on the first page \(from: 0\)\./);
    }
    const next = /^The listing continues: call open_standard_for_filling again with from: (\d+)\.$/.exec(body[5]);
    if (!next) { assert.equal(body[5], 'End of the listing.'); break; }
    from = Number(next[1]);
    assert.equal(view.listing[from - 1], '\n', 'the next page starts on a line');
    assert.match(body[4], /[^\n]$/, 'a page never ends mid-line or with the cut newline');
  }
  assert.ok(pages.length >= 3, `several pages (${pages.length})`);
  assert.equal(pages.join('\n'), view.listing, 'the pages are the whole listing, nothing twice, nothing missing');
  assert.match(pages[0], /^PART: word\/document\.xml\n¶1 \[H1\] LONG STANDARD\n¶2 /);
  const beyond = await run('open_standard_for_filling', { documentTypeId: T_LONG, from: view.listing.length + 5 });
  assert.match(beyond, /^The listing of Long Standard's standard \(Long\.docx\) is [\d,]+ characters long; there is nothing at [\d,]+\. templateHash: [0-9a-f]{64}$/);
});

test('pageOfListing cuts at a line end and copes with one line longer than the budget', () => {
  const listing = 'aaaa\nbbbb\ncccc';
  assert.deepEqual(pageOfListing(listing, 0, 7), { text: 'aaaa', end: 5 });
  assert.deepEqual(pageOfListing(listing, 5, 7), { text: 'bbbb', end: 10 });
  assert.deepEqual(pageOfListing(listing, 10, 7), { text: 'cccc', end: 14 });
  assert.deepEqual(pageOfListing(listing, 0, 100), { text: listing, end: 14 });
  assert.deepEqual(pageOfListing('x'.repeat(50), 0, 20), { text: 'x'.repeat(20), end: 20 });
  assert.deepEqual(pageOfListing('x'.repeat(50) + '\ny', 0, 20), { text: 'x'.repeat(20), end: 20 });
});

test('a type without a Word standard, a wrong id, a broken file and a missing file each get one plain sentence', async () => {
  const { run } = tools();
  assert.match(await run('open_standard_for_filling', { documentTypeId: T_NONE }), /^Board Resolution has no standard yet, so there is nothing to fill: draft it from the firm's rules \(get_firm_rules\) and precedents \(search_precedents\) instead\./);
  assert.match(await run('open_standard_for_filling', { documentTypeId: T_TEXT }), /^Seeded Agreement's standard is text only \(no Word file\), so there is nothing to fill: read_standard gives its text to draft from\./);
  await assert.rejects(run('open_standard_for_filling', { documentTypeId: 'not-an-id' }), /documentTypeId must be a document type id \(a UUID\)/);
  await assert.rejects(run('open_standard_for_filling', { documentTypeId: '99999999-9999-4999-8999-999999999999' }), /There is no document type with that id/);
  await assert.rejects(run('open_standard_for_filling', { documentTypeId: T_BROKEN }), /The standard's file Broken\.docx could not be read as a Word document: Not a Word file/);
  await assert.rejects(run('open_standard_for_filling', { documentTypeId: T_MISSING }), /Could not open the standard's file: Object not found\./);
});

test('createStandardLoader returns the bytes, their hash, the full view and the composed listing consistently; standardRows is the row lookup the fill tool shares', async () => {
  clearStandardCache();
  const f = fixtures();
  const supabase = fakeSupabase(f.tables, f.files);
  const loader = createStandardLoader({ supabase });
  const s = await loader.load(T_CA);
  assert.equal(s.type.name, 'Concession Agreement');
  assert.equal(s.template.storage_path, `standards/${T_CA}/1-CA.docx`);
  assert.equal(s.snapshot.id, SNAP);
  assert.equal(sha(s.bytes), sha(SMALL));
  assert.equal(s.hash, sha(SMALL));
  const full = inspectDocx(SMALL, { budget: Infinity });
  assert.equal(s.inspection.paragraphCount, full.paragraphCount);
  assert.equal(s.inspection.partial, false, 'the full view: every paragraph addressable, as the fill tool reads it');
  assert.equal(s.listing, fillListing(full).listing);
  assert.equal(s.shown, 6);
  assert.deepEqual(s.blanks, { body: 3, notes: 0 });
  const none = await loader.load(T_NONE);
  assert.deepEqual([none.template, none.bytes, none.hash, none.inspection, none.listing], [null, null, null, null, null]);
  const text = await loader.load(T_TEXT);
  assert.equal(text.template.storage_path, null);
  assert.equal(text.bytes, null);
  assert.equal(supabase.downloads.length, 1);
  // The rows alone, as fillStandardWrite.js reads them before its own download.
  const rows = await standardRows(supabase, T_CA);
  assert.deepEqual(Object.keys(rows), ['type', 'template', 'snapshot']);
  assert.equal(rows.snapshot.id, SNAP);
  assert.equal((await standardRows(supabase, T_TEXT)).snapshot, null);
  assert.equal((await standardRows(supabase, T_NONE)).template, null);
  await assert.rejects(standardRows(supabase, T_MISSING.replace(/f/g, '0')), /There is no document type with that id/);
  assert.equal(supabase.downloads.length, 1, 'rows only, no download');
});

test('a standard the Hub\'s placeholder view cannot hold: every blank is still listed, each gap names its paragraphs, the footnote drafting notes are said to be notes', async () => {
  const { run } = tools();
  const hub = inspectDocx(BIG, { placeholders: true });
  const hidden = [...hub.byRef.values()].filter((r) => PH.test(r.exactText) && !r.shown);
  assert.ok(hub.listing.length >= MAX_LISTING_CHARS && hidden.length > 0, `the Hub's own view hides ${hidden.length} blank paragraphs of this standard`);
  const full = inspectDocx(BIG, { budget: Infinity });
  const blanks = [...full.byRef.values()].filter((r) => PH.test(r.exactText));
  assert.deepEqual(blankCounts(full), { body: 301, notes: 90 }, '300 in the body and the header\'s one');
  const pages = [];
  let from = 0;
  let first = null;
  for (let i = 0; i < 40; i++) {
    const out = await run('open_standard_for_filling', { documentTypeId: T_BIG, from });
    assert.ok(out.length < MAX_RESULT_CHARS, `page ${i + 1} under the cap`);
    if (i === 0) first = out;
    const body = /\nPARAGRAPHS \(characters ([\d,]+)–([\d,]+) of ([\d,]+)\):\n([\s\S]*)\n\n\[(.*)\]$/.exec(out);
    assert.ok(body);
    pages.push(body[4]);
    const next = /with from: (\d+)\.$/.exec(body[5]);
    if (!next) break;
    from = Number(next[1]);
  }
  const listing = pages.join('\n');
  assert.equal(listing, fillListing(full).listing);
  for (const r of blanks) assert.ok(listing.includes(`\n¶${r.index} ${r.exactText}\n`) || listing.includes(`\n¶${r.index} ${r.exactText}`), `¶${r.index} is listed`);
  assert.ok(first.startsWith(`Big Standard: the firm's Word standard Big.docx, as stored 4 Oct 2026 — 3,091 paragraphs, 301 of them with a blank to fill, every one listed with its ¶ number; 90 more bracketed paragraphs are the firm's drafting notes in the footnotes (listed under their PART line for context, not slots to fill: the lawyer removes them in Word before circulation). ${fillListing(full).shown} of the 3,091 paragraphs are listed (the blanks, every heading and the paragraphs around each blank); the rest are gaps marked "not shown" with their ¶ numbers, which paragraphs: "from-to" reads.\n`), first.split('\n')[0]);
  // Every heading, each blank with its neighbours; the gaps name what they hide.
  assert.match(listing, /^PART: word\/document\.xml\n¶1 \[H1\] ARTICLE 1 — OBLIGATIONS\n   … 7 paragraphs not shown: ¶2–¶8 …\n¶9 /);
  assert.match(listing, /\n¶9 9\. The Concessionaire shall, at its own cost[^\n]*\n¶10 10\. The Concessionaire shall pay the Authority PKR \[●\][^\n]*\n¶11 11\. The Concessionaire shall, at its own cost[^\n]*\n   … 7 paragraphs not shown: ¶12–¶18 …\n¶19 /);
  assert.match(listing, /\n¶201 \[H1\] ARTICLE 2 — OBLIGATIONS\n/);
  assert.match(listing, /\n\nPART: word\/footnotes\.xml\n¶3001 \[Drafting Note\] Insert the figure the term sheet gives for item 1;/);
  assert.ok(!/not shown: ¶\d+–¶\d+ …\n   …/.test(listing), 'never two gaps in a row');
  // A hidden paragraph read by range, with the ¶ numbers and words the fill tool resolves against.
  const range = await run('open_standard_for_filling', { documentTypeId: T_BIG, paragraphs: '12-18' });
  assert.match(range, /^Big Standard: the firm's Word standard Big\.docx — paragraphs ¶12–¶18 of 3,091, every one in that range as the standard reads \(an empty paragraph has no number\)\.\ntemplateHash: [0-9a-f]{64}\n/);
  assert.ok(range.includes(`\n\nPARAGRAPHS ¶12–¶18:\nPART: word/document.xml\n¶12 ${BIG_CLAUSE(12)}\n¶13 ${BIG_CLAUSE(13)}\n`));
  assert.ok(range.endsWith(`¶18 ${BIG_CLAUSE(18)}\n\n[End of the range; the standard goes on to ¶3,091.]`));
  assert.ok(!range.includes(OPS_PROTOCOL) && /on the listing's first page \(from: 0\)/.test(range));
  for (const n of [12, 13, 18]) assert.equal(full.byRef.get(n).exactText, BIG_CLAUSE(n), 'the same text the fill tool will expect');
  // A wide range is cut to MAX_RANGE and continues; one across the footnotes shows both parts; the end; a range past the end; a malformed one.
  const wide = await run('open_standard_for_filling', { documentTypeId: T_BIG, paragraphs: '2990-3010' });
  assert.equal(MAX_RANGE, 200);
  assert.match(wide, /paragraphs ¶2,990–¶3,010 of 3,091/);
  assert.match(wide, /\n¶3000 3000\. The Concessionaire shall pay[^\n]*\n\nPART: word\/footnotes\.xml\n¶3001 \[Drafting Note\]/);
  assert.ok(wide.endsWith('¶3010 [Drafting Note] Insert the figure the term sheet gives for item 10; delete this note before circulation.\n\n[End of the range; the standard goes on to ¶3,091.]'));
  assert.ok((await run('open_standard_for_filling', { documentTypeId: T_BIG, paragraphs: '3080-3091' })).endsWith('[The standard ends here.]'));
  const cut = await run('open_standard_for_filling', { documentTypeId: T_BIG, paragraphs: '¶1–¶400' });
  assert.match(cut, /paragraphs ¶1–¶200 of 3,091, .* The range was cut to 200 paragraphs; ask for the rest next\./);
  assert.match(cut, /\n\n\[(The range continues|Stopped at ¶\d+ to stay under the size limit): call open_standard_for_filling again with paragraphs: "\d+-\d+"\.\]$/);
  assert.ok(cut.length < MAX_RESULT_CHARS);
  assert.match(await run('open_standard_for_filling', { documentTypeId: T_BIG, paragraphs: '5000-5010' }), /^Big Standard's standard \(Big\.docx\) has 3,091 paragraphs \(¶1–¶3,091\); there is no ¶5,000\. templateHash: [0-9a-f]{64}$/);
  await assert.rejects(run('open_standard_for_filling', { documentTypeId: T_BIG, paragraphs: 'all of it' }), /paragraphs must be a range of paragraph numbers such as "100-140"/);
  await assert.rejects(run('open_standard_for_filling', { documentTypeId: T_BIG, paragraphs: '40-30' }), /paragraphs must be a range/);
});

test('parseRange, rangeListing and fillListing on their own', () => {
  assert.deepEqual(parseRange('100-140'), { from: 100, to: 140, cut: false });
  assert.deepEqual(parseRange(' ¶7 – ¶9 '), { from: 7, to: 9, cut: false });
  assert.deepEqual(parseRange('120'), { from: 120, to: 120, cut: false });
  assert.deepEqual(parseRange('1-1000'), { from: 1, to: 200, cut: true });
  assert.equal(parseRange('0-5'), null);
  assert.equal(parseRange('9-3'), null);
  assert.equal(parseRange('x'), null);
  const full = inspectDocx(SMALL, { budget: Infinity });
  const r = rangeListing(full, { from: 4, to: 6 }, 10_000);
  assert.deepEqual([r.last, r.count, r.more], [6, 3, false]);
  assert.equal(r.text, 'PART: word/document.xml\n¶4 The Concession Period is thirty (30) years from the Effective Date.\n¶5 [table] Project Site: ____ hectares at [●].\n\nPART: word/header1.xml\n¶6 [Project Name] — Concession Agreement');
  const tight = rangeListing(full, { from: 1, to: 6 }, 120);
  assert.ok(tight.more && tight.last < 6 && tight.count >= 1, 'the budget stops the read after whole lines');
  assert.equal(rangeListing(full, { from: 7, to: 9 }, 10_000).count, 0);
  // fillListing: a blank's neighbours stay within their part; a heading alone is kept.
  const only = standardDocx(p('TITLE', 'Heading1') + p('one') + p('two') + p('three [●]') + p('four') + p('five') + p('six'));
  const view = fillListing(inspectDocx(only, { budget: Infinity }));
  assert.equal(view.listing, 'PART: word/document.xml\n¶1 [H1] TITLE\n   … 1 paragraph not shown: ¶2 …\n¶3 two\n¶4 three [●]\n¶5 four\n   … 2 paragraphs not shown: ¶6–¶7 …\n\nPART: word/header1.xml\n¶8 [Project Name] — Concession Agreement');
  assert.equal(view.shown, 5);
});

test('server.js prompts with firmRules.js FILL_INSTRUCTIONS, so the Hub and the connector cannot drift', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /import \{[^}]*\bFILL_INSTRUCTIONS\b[^}]*\bFILL_DIRECT_NOTE\b[^}]*\} from "\.\/firmRules\.js";/);
  assert.ok(server.includes('BY FILLING IN THE FIRM\'S STANDARD.\\n\\n${listing}\\n\\n${FILL_INSTRUCTIONS}${templateRules?.trim()'), 'the fill prompt is built from the export');
  assert.ok(server.includes('${OPS_PROTOCOL}\\n\\n${FILL_DIRECT_NOTE}`'));
  assert.ok(!server.includes('This is a fill-in job, not a drafting job'), 'the words live in firmRules.js only');
  assert.match(FILL_INSTRUCTIONS, /^This is a fill-in job, not a drafting job\. The standard's wording is the firm's: put the deal's facts into it and change nothing else\. Fill each \[●\], \[•\], \[____\] or \[bracketed\] placeholder/);
  assert.match(FILL_INSTRUCTIONS, /Ask a question only if nothing at all can be filled without the answer\.$/);
  assert.equal(FILL_DIRECT_NOTE, 'IN THIS DRAFT: "applied as a tracked change" above does not apply — every change is written directly into the document.');
});
