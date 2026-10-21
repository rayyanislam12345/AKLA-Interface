// Piece 3.2 of the connector: fill_standard_to_project
// (connector/tools/fillStandardWrite.js). Against a stub database, a stub
// precedent-library bucket holding a small real Word standard built here,
// and the real projectWrites over a stub matter-documents bucket: the
// standard is read and never written; a changed standard (sha256 ≠
// templateHash) is refused; more than 300 changes are refused before
// anything is read; a fill that outlasts the deadline writes nothing; the
// fills land accepted while an AKLA Comments margin comment stays, even
// one quoting the paragraph's new wording; every change that could not be
// made is named with its reason and every blank left in the file is
// counted; a refusal from the database takes the upload back and is
// recorded as failed; the version is the lawyer's own filing with the
// "Drafted from the firm's standard" label; one fill runs at a time and a
// second is refused in one sentence; the real applyDocxOps stops at the
// deadline's signal; characters Word cannot read never reach the file.
// No network, no Python.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { z } from 'zod';
import { WRITE } from '../connector/app.js';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES } from '../connector/tools.js';
import { DEFAULT_SCOPE, READ_SCOPE, READ_ONLY_REFUSAL } from '../connector/oauth.js';
import { BUCKET, createProjectWrites } from '../connector/projectWrites.js';
import { inspectDocx, applyDocxOps } from '../docxAgent.js';
import fill, {
  createFillStandardTools, readOps, fillLabel, sha256, blanksLine, changesLines, isFilling,
  FILL_TOOL, STANDARDS_BUCKET, MAX_OPS, MAX_OP_TEXT_CHARS, APPLY_TIMEOUT_MS, DOCX_MIME,
  STANDARD_CHANGED_SENTENCE, TOO_LONG_SENTENCE, BUSY_SENTENCE, UNRECORDED_LINE,
} from '../connector/tools/fillStandardWrite.js';

const USER = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NEW_V = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const T_CA = '12121212-1212-4121-8121-121212121212';
const T_NDA = '34343434-3434-4343-8343-343434343434';
const T_NONE = '56565656-5656-4565-8565-565656565656';
const CLOCK = Date.parse('2026-10-20T09:00:00Z');
const HUB = 'https://hub.test';
const CA_PATH = `standards/${T_CA}/1-Standard-Concession-Agreement.docx`;
const NDA_PATH = `standards/${T_NDA}/1-NDA.html`;

// ---------------------------------------------------------------------------
// A small real Word standard with the firm's blanks: five body paragraphs
// and one table cell, as docxAgent reads them.

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
const P_TITLE = 'CONCESSION AGREEMENT';
const P_PARTIES = 'This Concession Agreement is made on [●] between [Name of the Grantor] (the Grantor) and [Name of the Concessionaire] (the Concessionaire).';
const P_PERIOD = 'The Concession Period is [●] years from the Effective Date.';
const P_LAW = 'The Governing Law is the law of [●].';
const P_SECURITY = 'The Performance Security is PKR [●].';
const P_CELL = 'Schedule 1 — [●]';
const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const BODY = [P_TITLE, P_PARTIES, P_PERIOD, P_LAW, P_SECURITY].map(para).join('') + `<w:tbl><w:tr><w:tc>${para(P_CELL)}</w:tc></w:tr></w:tbl>`;
const docFrom = (body) => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
  'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`),
}, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) });
const STANDARD = docFrom(BODY);
const HASH = sha256(STANDARD);
const partOf = (bytes, part) => { const e = unzipSync(bytes)[part]; return e ? strFromU8(e) : null; };
const textOf = (xml) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
/** The ¶ number of a paragraph in the standard, as open_standard_for_filling would print it. */
const view = inspectDocx(STANDARD, { budget: Infinity });
const at = (text) => [...view.byRef].find(([, r]) => r.exactText === text)[0];

// ---------------------------------------------------------------------------
// A Supabase stub: tables with the filters the module and the foundation
// use, two buckets (the standards one answers downloads and remembers any
// write; the matter one remembers uploads and removals), an rpc that plays
// save_document_version_as.

function fakeSupabase({ tables = {}, rpc = async () => ({ data: null, error: null }), files = {} } = {}) {
  const calls = { upload: [], remove: [], rpc: [], insert: [], update: [], download: [] };
  const objects = new Set();
  const chain = (table) => {
    let rows = [...(tables[table] ?? [])];
    let single = false;
    let inserted = null;
    const q = {
      select() { return q; },
      order(col, { ascending } = {}) { rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending === false ? -1 : 1)); return q; },
      limit(n) { rows = rows.slice(0, n); return q; }, range() { return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      in(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      gte(col, val) { rows = rows.filter((r) => r[col] >= val); return q; },
      maybeSingle() { single = true; return q; },
      insert(row) { inserted = row; calls.insert.push({ table, row }); (tables[table] ??= []).push(row); return q; },
      update(patch) { calls.update.push({ table, patch }); return q; },
      then(ok, bad) { return Promise.resolve({ data: inserted ? null : single ? rows[0] ?? null : rows, error: null }).then(ok, bad); },
    };
    return q;
  };
  return {
    calls, objects, tables,
    from: chain,
    rpc: async (name, args) => { calls.rpc.push({ name, args }); return rpc(name, args, { objects, tables }); },
    storage: {
      from: (bucket) => ({
        upload: async (path, body, opts) => { calls.upload.push({ bucket, path, body, opts }); if (bucket === BUCKET) objects.add(path); return { data: { path }, error: null }; },
        remove: async (paths) => { calls.remove.push({ bucket, paths }); for (const p of paths) objects.delete(p); return { data: paths, error: null }; },
        download: async (path) => { calls.download.push({ bucket, path }); const f = files[`${bucket}/${path}`]; return f ? { data: new Blob([f]), error: null } : { data: null, error: { message: 'Object not found' } }; },
      }),
    },
  };
}

function scriptedSave(t, { fail = null } = {}) {
  return async (name, args, { objects }) => {
    assert.equal(name, 'save_document_version_as');
    if (fail) return { data: null, error: { message: fail } };
    if (!objects.has(args.p_storage_path)) return { data: null, error: { message: 'The uploaded file is unavailable' } };
    const versions = (t.tables.document_versions ?? []).filter((v) => v.matter_document_id === args.p_document_id).sort((a, b) => b.version_number - a.version_number);
    if (!args.p_create_new) {
      const doc = (t.tables.matter_documents ?? []).find((d) => d.id === args.p_document_id && d.matter_id === args.p_matter_id);
      if (!doc) return { data: null, error: { message: 'Document does not belong to this project and type' } };
      if ((versions[0]?.id ?? null) !== args.p_expected_version_id) return { data: null, error: { message: 'A newer document version exists. Reopen the latest version before saving these edits.' } };
    }
    const number = (versions[0]?.version_number ?? 0) + 1;
    const row = { id: NEW_V, matter_document_id: args.p_document_id, version_number: number, storage_path: args.p_storage_path, file_name: `${args.p_file_stem}-v${number}.${args.p_extension}`, is_ai_generated: args.p_is_ai_generated, uploaded_by: args.p_user_id, label: args.p_label };
    (t.tables.document_versions ??= []).push(row);
    return { data: { matterDocumentId: args.p_document_id, versionId: row.id, versionNumber: number, fileName: row.file_name }, error: null };
  };
}

const fixtures = () => ({
  matters: [{ id: P1, name: 'Hyderabad Bypass', status: 'active', client: { name: 'Sindh PPP Unit' } }, { id: P2, name: 'KPT Corridor', status: 'active' }],
  matter_documents: [{ id: D1, title: 'Concession Agreement', matter_id: P1, document_type_id: T_CA }],
  document_versions: [{ id: V1, matter_document_id: D1, version_number: 1, storage_path: `${P1}/${D1}/x-CA.docx`, file_name: 'CA-v1.docx' }],
  document_types: [{ id: T_CA, name: 'Concession Agreement' }, { id: T_NDA, name: 'Non-Disclosure Agreement' }, { id: T_NONE, name: 'Board Resolution' }],
  document_type_templates: [
    { document_type_id: T_CA, storage_path: CA_PATH, filename: 'Standard Concession Agreement [AKLA].docx', updated_at: '2026-10-01T08:00:00Z' },
    { document_type_id: T_NDA, storage_path: NDA_PATH, filename: 'NDA.html', updated_at: '2026-08-01T08:00:00Z' },
  ],
  document_template_versions: [{ id: 'tv1', document_type_id: T_CA, storage_path: CA_PATH, filename: 'Standard Concession Agreement [AKLA].docx', created_at: '2026-10-01T08:00:00Z' }],
  connector_actions: [],
});

const ctxOf = (extra = {}) => ({ userId: USER, clientId: 'akh_c_test', scope: DEFAULT_SCOPE, tokenId: 't1', canWrite: true, recheck: async () => ({ userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' }), ...extra });

/** The tool through the registry, with the real foundation over the stub database; checkCaps is wrapped to count releases. */
function setup({ tables = fixtures(), standard = STANDARD, saveFails = null, options = {} } = {}) {
  const t = { tables };
  const supabase = fakeSupabase({ tables, rpc: scriptedSave(t, { fail: saveFails }), files: { [`${STANDARDS_BUCKET}/${CA_PATH}`]: standard, [`${STANDARDS_BUCKET}/${NDA_PATH}`]: strToU8('<p>NDA</p>') } });
  const lines = [];
  const log = (l) => lines.push(l);
  const real = createProjectWrites({ supabase, hubUrl: HUB, now: () => new Date(CLOCK), log });
  const caps = { checked: 0, released: 0 };
  const writes = {
    ...real,
    checkCaps: async (ctx) => { caps.checked += 1; const h = await real.checkCaps(ctx); return { ...h, release: () => { caps.released += 1; h.release(); } }; },
  };
  const modules = [{ file: 'fillStandardWrite.js', tools: (deps) => createFillStandardTools(deps, options) }];
  const list = createHubTools({ supabase, voyageKey: 'v', library: { searchLaw: async () => [], readActSection: async () => { throw new Error('no'); }, searchPrecedentsTool: async () => [], searchProject: async () => [] }, readFile: async () => ({ blocks: [] }), log, hubUrl: `${HUB}/`, modules, writes, now: () => CLOCK });
  const tool = list.find((x) => x.name === FILL_TOOL);
  const run = (input, ctx = ctxOf()) => tool.run(input, ctx);
  return { supabase, tables, lines, caps, list, tool, run };
}

const actions = (s) => s.tables.connector_actions;
const standardWrites = (s) => [...s.supabase.calls.upload, ...s.supabase.calls.remove].filter((c) => c.bucket === STANDARDS_BUCKET);
/** The usual fill: the parties and the period in, a question on the law, one slot with a stale quote and one paragraph that is not there. */
const usualOps = () => [
  { op: 'replace', p: at(P_PARTIES), expected: P_PARTIES, text: 'This Concession Agreement is made on 1 November 2026 between the Government of Sindh (the Grantor) and Hyderabad Bypass Company (Private) Limited (the Concessionaire).', why: 'The parties from the brief.' },
  { op: 'replace', p: at(P_PERIOD), expected: P_PERIOD, text: 'The Concession Period is thirty (30) years from the Effective Date.' },
  { op: 'comment', p: at(P_LAW), expected: P_LAW, text: 'Confirm whether the Grantor will accept Sindh law or insists on the law of Pakistan generally.' },
  { op: 'replace', p: at(P_SECURITY), expected: 'The Performance Security is PKR [•].', text: 'The Performance Security is PKR 500,000,000.' },
  { op: 'replace', p: 99, expected: 'Nothing here', text: 'Nothing there' },
];
const usualInput = (extra = {}) => ({ documentTypeId: T_CA, projectId: P1, title: 'Concession Agreement — Hyderabad Bypass', ops: usualOps(), templateHash: HASH, ...extra });

// ---------------------------------------------------------------------------
// Shape

test('fillStandardWrite.js adds one write tool with the foundation\'s annotations, a lawyer\'s description and the plan\'s schema', async () => {
  const loaded = await loadToolModules();
  assert.ok(loaded.some((m) => m.file === 'fillStandardWrite.js'), 'the module is in the directory the connector loads');
  const { list, tool } = setup();
  assert.deepEqual(list.map((x) => x.name), [...BUILT_IN_TOOL_NAMES, FILL_TOOL]);
  assert.equal(FILL_TOOL, 'fill_standard_to_project');
  assert.equal(tool.write, true);
  assert.deepEqual(tool.annotations, WRITE, 'readOnlyHint false, destructiveHint true (owner decision)');
  assert.ok(tool.description.length > 400);
  assert.match(tool.description, /NEW version, never over one/);
  assert.match(tool.description, /claude\.ai asks the lawyer/);
  assert.match(tool.description, /recorded against the lawyer/);
  assert.match(tool.description, /stays \[●\]/);
  assert.match(tool.description, /AKLA Comments/);
  assert.match(tool.description, /standard in the library is never changed/);
  assert.match(tool.description, /not legal approval/);
  assert.match(tool.description, /At most 300 changes/);
  for (const k of ['documentTypeId', 'projectId', 'title', 'ops', 'templateHash', 'matterDocumentId', 'label']) assert.ok(tool.inputSchema[k] instanceof z.ZodType, `takes ${k}`);
  const ops = tool.inputSchema.ops;
  assert.ok(ops.safeParse(usualOps()).success);
  assert.equal(ops.safeParse([]).success, false, 'at least one change');
  assert.equal(ops.safeParse(Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'delete', p: 1, expected: 'x' }))).success, false, 'the cap is in the schema');
  assert.equal(ops.safeParse([{ op: 'replace', p: 1, expected: 'x', text: 'y'.repeat(MAX_OP_TEXT_CHARS + 1) }]).success, false, 'text ≤ 20,000 chars per op');
  assert.equal(ops.safeParse([{ op: 'rewrite', p: 1, expected: 'x', text: 'y' }]).success, false, 'only the four ops');
  assert.equal(MAX_OPS, 300);
  assert.equal(MAX_OP_TEXT_CHARS, 20_000);
  assert.equal(APPLY_TIMEOUT_MS, 200_000);
  assert.equal(STANDARDS_BUCKET, 'precedent-library');
  // The default export is the same tool with the real applyDocxOps behind it; the registry accepts it beside the other modules.
  const all = createHubTools({ supabase: fakeSupabase(), voyageKey: 'v', log: () => {}, modules: [...loaded.filter((m) => m.file !== 'fillStandardWrite.js'), fill], writes: {} });
  assert.ok(all.some((x) => x.name === FILL_TOOL));
});

test('readOps, fillLabel, blanksLine and sha256: the cap, the shape of a change, the label with and without the lawyer\'s own, the blanks summary', () => {
  assert.throws(() => readOps([]), /ops must be a list of at least one change/);
  assert.throws(() => readOps(Array.from({ length: 301 }, () => ({ op: 'delete', p: 1, expected: 'x' }))), /^Error: fill_standard_to_project takes at most 300 changes in one call \(301 were sent\); file the first 300 now and the rest as the next version of the same document\.$/);
  assert.throws(() => readOps([{ op: 'rewrite', p: 1, expected: 'x', text: 'y' }]), /Change 1: op must be one of replace, insert_after, delete, comment, write, repeat_block, add_row, remove_block\./);
  assert.throws(() => readOps([{ op: 'replace', p: 0, expected: 'x', text: 'y' }]), /Change 1: p must be the paragraph's number/);
  assert.throws(() => readOps([{ op: 'replace', p: 1, text: 'y' }]), /Change 1: expected must be the paragraph's exact current text\./);
  assert.throws(() => readOps([{ op: 'replace', p: 1, expected: 'x', text: '  ' }]), /Change 1: replace needs text\./);
  assert.throws(() => readOps([{ op: 'comment', p: 1, expected: 'x', text: 'y'.repeat(20_001) }]), /Change 1: text is longer than 20,000 characters/);
  assert.deepEqual(readOps([{ op: ' Replace ', p: '3', expected: 'a', text: 'b', why: '  the   brief ' }, { op: 'delete', p: 4, expected: 'c', text: 'ignored' }]), [{ op: 'replace', p: 3, expected: 'a', text: 'b', why: 'the brief' }, { op: 'delete', p: 4, expected: 'c' }]);
  // Characters XML 1.0 forbids (Word would call the file unreadable) are dropped; tabs, newlines and ordinary text stay.
  assert.deepEqual(readOps([{ op: 'replace', p: 1, expected: 'a\u0000b', text: 'c\u0001\u000B\u000C\u001Fd\te\nf & <g>' }]), [{ op: 'replace', p: 1, expected: 'ab', text: 'cd\te\nf & <g>' }]);
  assert.throws(() => readOps([{ op: 'replace', p: 1, expected: 'x', text: '\u0000\u0001' }]), /Change 1: replace needs text\./);
  assert.equal(fillLabel(null, new Date(CLOCK)), "Drafted from the firm's standard in claude.ai — 20 October 2026");
  assert.equal(fillLabel('  For partner   review ', new Date(CLOCK)), "For partner review: Drafted from the firm's standard in claude.ai — 20 October 2026");
  assert.ok(fillLabel('x'.repeat(300), new Date(CLOCK)).length <= 200);
  assert.match(fillLabel('x'.repeat(300), new Date(CLOCK)), /…: Drafted from the firm's standard in claude\.ai — 20 October 2026$/);
  assert.equal(blanksLine([]), 'Blanks left in the filed draft: none.');
  assert.equal(blanksLine([{ text: '[●]' }, { text: '[Name of the Grantor]' }, { text: '[●]' }]), 'Blanks left in the filed draft: 3 ([●] ×2, [Name of the Grantor]). They stay [●] until the lawyer fills them.');
  // The footnotes' bracketed drafting notes are not blanks the lawyer left.
  assert.equal(blanksLine([{ part: 'word/document.xml', text: '[●]' }, { part: 'word/header1.xml', text: '[Project]' }, { part: 'word/footnotes.xml', text: '[Drafting Note]' }, { part: 'word/footnotes.xml', text: '[Drafting Note]' }]), 'Blanks left in the filed draft: 2 ([●], [Project]). They stay [●] until the lawyer fills them. 2 bracketed drafting notes in the footnotes stay as in the standard, for the lawyer to remove in Word before circulation.');
  assert.equal(blanksLine([{ part: 'word/footnotes.xml', text: '[Drafting Note]' }]), 'Blanks left in the filed draft: none. 1 bracketed drafting note in the footnotes stays as in the standard, for the lawyer to remove in Word before circulation.');
  assert.equal(sha256(STANDARD), HASH);
  assert.match(HASH, /^[0-9a-f]{64}$/);
  assert.notEqual(sha256(docFrom(BODY + para('one more'))), HASH);
});

// ---------------------------------------------------------------------------
// The fill

test('the facts go into the standard and land accepted, the comment stays in the margin, every slot that could not be filled is named, the blanks are counted, and the version is the lawyer\'s own filing with the standard\'s label', async () => {
  const s = setup();
  let rechecked = 0;
  const ctx = ctxOf({ recheck: async () => { rechecked += 1; return { userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' }; } });
  const out = await s.run(usualInput(), ctx);
  assert.equal(rechecked, 1, 'the sign-in was checked afresh first');
  assert.equal(s.caps.checked, 1);
  assert.equal(s.caps.released, 1, 'the caps handle was released');
  // The standard was read from the precedent library, and never written.
  assert.deepEqual(s.supabase.calls.download, [{ bucket: STANDARDS_BUCKET, path: CA_PATH }]);
  assert.deepEqual(standardWrites(s), [], 'nothing is written to the precedent library');
  assert.equal(s.supabase.calls.update.length, 0, 'document_type_templates is never updated');
  // The upload: the project, a new document id, the stem from the title, a Word file.
  assert.equal(s.supabase.calls.upload.length, 1);
  const up = s.supabase.calls.upload[0];
  assert.equal(up.bucket, BUCKET);
  assert.match(up.path, new RegExp(`^${P1}/[0-9a-f-]{36}/[0-9a-f-]{36}-Concession-Agreement-Hyderabad-Bypass\\.docx$`));
  assert.deepEqual(up.opts, { contentType: DOCX_MIME, upsert: false });
  assert.notEqual(sha256(up.body), HASH, 'the filed file is not the standard');
  // The file: the two fills accepted (no AKLA AI revision marks, the new words plain), the comment anchored with its text in the comments part, the unfilled slots as they were.
  const xml = partOf(up.body, 'word/document.xml');
  assert.ok(!/w:author="AKLA AI"/.test(xml), 'the fills are born accepted');
  assert.ok(!/<w:ins\b|<w:del\b/.test(xml), 'no tracked change is left in the file');
  const text = textOf(xml);
  assert.match(text, /made on 1 November 2026 between the Government of Sindh \(the Grantor\) and Hyderabad Bypass Company \(Private\) Limited/);
  assert.match(text, /The Concession Period is thirty \(30\) years from the Effective Date\./);
  assert.ok(!text.includes('[Name of the Grantor]'));
  assert.ok(!text.includes('[●] years'));
  assert.ok(text.includes(P_LAW), 'the commented paragraph keeps its text');
  assert.ok(text.includes(P_SECURITY), 'the slot with the stale quote is untouched');
  assert.ok(text.includes(P_CELL), 'the table is untouched');
  assert.match(xml, /<w:commentRangeStart w:id="0"\/>/);
  const comments = partOf(up.body, 'word/comments.xml');
  assert.ok(comments, 'the comments part was created');
  assert.match(comments, /w:author="AKLA Comments"/);
  assert.match(comments, /Confirm whether the Grantor will accept Sindh law/);
  // The RPC: as the lawyer, a new document under the type, not AI-generated, the standard's label.
  const args = s.supabase.calls.rpc[0].args;
  assert.equal(args.p_user_id, USER);
  assert.equal(args.p_create_new, true);
  assert.equal(args.p_document_type_id, T_CA);
  assert.equal(args.p_title, 'Concession Agreement — Hyderabad Bypass');
  assert.equal(args.p_extension, 'docx');
  assert.equal(args.p_is_ai_generated, false, 'the lawyer\'s own filing');
  assert.equal(args.p_label, "Drafted from the firm's standard in claude.ai — 20 October 2026");
  // One record, with the ids and never the text.
  assert.equal(actions(s).length, 1);
  const row = actions(s)[0];
  assert.equal(row.tool, FILL_TOOL);
  assert.equal(row.outcome, 'saved');
  assert.equal(row.project_id, P1);
  assert.equal(row.document_id, args.p_document_id);
  assert.equal(row.version_id, NEW_V);
  assert.equal(row.label, "Drafted from the firm's standard in claude.ai — 20 October 2026");
  assert.ok(!JSON.stringify(row).includes('Sindh'), 'never the document\'s text');
  // The reply: the filing, the account of the changes, the blanks, the ids, the Hub pages.
  const lines = out.split('\n');
  assert.equal(lines[0], `Drafted "Concession Agreement — Hyderabad Bypass" from the firm's Concession Agreement standard (Standard Concession Agreement [AKLA].docx) and filed it as v1 (Concession-Agreement-Hyderabad-Bypass-v1.docx), a new document on Hyderabad Bypass, labelled "Drafted from the firm's standard in claude.ai — 20 October 2026".`);
  assert.equal(lines[1], 'Changes: 3 of 5 made (2 in the text, 1 margin comment); 2 could not be made.');
  assert.equal(lines[2], 'Could not be made (the slot is as it was in the standard):');
  assert.equal(lines[3], `- Changed ¶${at(P_SECURITY)}: The Performance Security is PKR 500,000,000. — Expected paragraph text does not match the source; no change was made.`);
  assert.equal(lines[4], '- Changed ¶99: Nothing there — Paragraph was not supplied to this turn; request that section first.');
  assert.equal(lines[5], "Format matches the firm's standard (Standard Concession Agreement [AKLA]).", 'the format gate passed and says so');
  assert.equal(lines[6], 'Blanks left in the filed draft: 3 ([●] ×3). They stay [●] until the lawyer fills them.');
  assert.match(out, new RegExp(`\ndocumentId: ${args.p_document_id}\nversionId: ${NEW_V}\nOpen in Hub: ${HUB}/ai/d/${NEW_V}\\?embed=1&host=pane\nProject Hyderabad Bypass — Open in Hub: ${HUB}/ai/p/${P1}\\?embed=1&host=pane\n`));
  assert.match(out, /\nOn file; the Hub is reading it now\./);
  assert.ok(!out.includes(UNRECORDED_LINE));
  assert.match(out, /The fills are accepted in the file; the AKLA Comments are margin comments for the lawyer\. The standard in the library is unchanged\. Filed as the lawyer's own version \(not marked AI-generated\).*not legal approval\.$/);
  assert.ok(!/https?:\/\/[^\s]*supabase/.test(out), 'no storage links');
});

test('a comment quoting the paragraph\'s new wording after a replace on the same paragraph survives (alignCommentExpectations), and the lawyer\'s own label goes in front', async () => {
  const s = setup();
  const newText = 'The Concession Period is twenty-five (25) years from the Effective Date.';
  const out = await s.run(usualInput({
    label: 'For partner review',
    ops: [
      { op: 'replace', p: at(P_PERIOD), expected: P_PERIOD, text: newText },
      { op: 'comment', p: at(P_PERIOD), expected: newText, text: 'The brief said 25 years; the PPP Unit\'s letter says 30. Confirm.' },
    ],
  }));
  assert.equal(out.split('\n')[1], 'Changes: 2 of 2 made (1 in the text, 1 margin comment); 0 could not be made.');
  const up = s.supabase.calls.upload[0];
  const xml = partOf(up.body, 'word/document.xml');
  assert.ok(textOf(xml).includes(newText));
  assert.ok(!/<w:ins\b/.test(xml));
  assert.match(xml, /<w:commentRangeStart w:id="0"\/>/);
  assert.match(partOf(up.body, 'word/comments.xml'), /The brief said 25 years/);
  assert.equal(s.supabase.calls.rpc[0].args.p_label, "For partner review: Drafted from the firm's standard in claude.ai — 20 October 2026");
  assert.match(out, /labelled "For partner review: Drafted from the firm's standard in claude\.ai — 20 October 2026"/);
});

test('a next version of an existing document: the document must be on the project, keeps its title, and the save is checked against its latest version', async () => {
  const s = setup();
  const out = await s.run(usualInput({ matterDocumentId: D1, title: undefined, ops: usualOps().slice(0, 2) }));
  const args = s.supabase.calls.rpc[0].args;
  assert.equal(args.p_create_new, false);
  assert.equal(args.p_document_id, D1);
  assert.equal(args.p_expected_version_id, V1);
  assert.equal(args.p_title, 'Concession Agreement');
  assert.match(out, /^Drafted "Concession Agreement" from .* and filed it as v2 \(Concession-Agreement-v2\.docx\), its next version on Hyderabad Bypass/);
  assert.equal(actions(s)[0].document_id, D1);
  const other = setup();
  await assert.rejects(other.run(usualInput({ projectId: P2, matterDocumentId: D1 })), /^Error: That document is not on KPT Corridor\.$/);
  assert.equal(other.supabase.calls.download.length, 0, 'nothing was read');
  assert.equal(other.caps.released, 1);
});

// ---------------------------------------------------------------------------
// Refusals

test('a changed standard is refused in one sentence, recorded as refused, with nothing read into a project and the standard untouched', async () => {
  const s = setup();
  await assert.rejects(s.run(usualInput({ templateHash: sha256(docFrom(BODY + para('a replaced standard'))) })), new RegExp(`^Error: ${STANDARD_CHANGED_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  assert.equal(s.supabase.calls.download.length, 1, 'the standard was read to check it');
  assert.equal(s.supabase.calls.upload.length, 0);
  assert.equal(s.supabase.calls.rpc.length, 0);
  assert.deepEqual(standardWrites(s), []);
  assert.deepEqual(actions(s).map((a) => a.outcome), ['refused']);
  assert.equal(s.caps.released, 1);
  const bad = setup();
  await assert.rejects(bad.run(usualInput({ templateHash: 'abc' })), /templateHash must be the standard's fingerprint \(a 64-character sha256\)/);
  assert.equal(bad.supabase.calls.download.length, 0);
});

test('more than 300 changes are refused before anything is read; nothing is recorded, the caps handle is released', async () => {
  const s = setup();
  const ops = Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'replace', p: at(P_PERIOD), expected: P_PERIOD, text: 'x' }));
  await assert.rejects(s.run(usualInput({ ops })), /^Error: fill_standard_to_project takes at most 300 changes in one call \(301 were sent\)/);
  assert.equal(s.supabase.calls.download.length, 0);
  assert.equal(s.supabase.calls.upload.length, 0);
  assert.equal(actions(s).length, 0);
  assert.equal(s.caps.checked, 1);
  assert.equal(s.caps.released, 1);
  // Exactly 300 is fine: they all land on the same paragraph, the first one applies.
  const ok = setup();
  const out = await ok.run(usualInput({ ops: Array.from({ length: MAX_OPS }, () => ({ op: 'comment', p: at(P_LAW), expected: P_LAW, text: 'Confirm the governing law.' })) }));
  assert.match(out, /^Drafted /m);
  assert.equal(ok.supabase.calls.upload.length, 1);
});

test('a fill that outlasts the deadline writes nothing: one sentence, the signal aborted, recorded as failed, no upload', async () => {
  let seen = null;
  const slow = (bytes, ops, byRef, { signal } = {}) => new Promise((resolve, reject) => {
    seen = signal;
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const s = setup({ options: { apply: slow, applyTimeoutMs: 40 } });
  const started = Date.now();
  await assert.rejects(s.run(usualInput()), new RegExp(`^Error: ${TOO_LONG_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  assert.ok(Date.now() - started < 2000);
  assert.ok(seen instanceof AbortSignal);
  assert.equal(seen.aborted, true);
  assert.equal(s.supabase.calls.upload.length, 0);
  assert.equal(s.supabase.calls.rpc.length, 0);
  assert.deepEqual(actions(s).map((a) => a.outcome), ['failed']);
  assert.equal(s.caps.released, 1);
  assert.match(TOO_LONG_SENTENCE, /over 200 seconds/);
  // An apply that ignores the signal and never settles is still cut off.
  const deaf = setup({ options: { apply: () => new Promise(() => {}), applyTimeoutMs: 40 } });
  await assert.rejects(deaf.run(usualInput()), /took too long/);
  assert.equal(deaf.supabase.calls.upload.length, 0);
  // The real applyDocxOps honours the signal: reached after the deadline (as the docx-redline-js fallback's awaits
  // let it be), it stops with the abort instead of going on with the changes, and the tool has already answered.
  let inner = null;
  const late = async (bytes, ops, byRef, opts) => { await new Promise((r) => setTimeout(r, 80)); inner = applyDocxOps(bytes, ops, byRef, opts); return inner; };
  const real = setup({ options: { apply: late, applyTimeoutMs: 30 } });
  await assert.rejects(real.run(usualInput()), /took too long/);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(inner, 'the apply ran on after the answer');
  await assert.rejects(inner, (err) => err?.name === 'AbortError');
  assert.equal(real.supabase.calls.upload.length, 0);
  assert.equal(isFilling(), false, 'the lock is released');
  // Straight to docxAgent: an aborted signal stops before any part is touched; no signal is the Hub's own call.
  await assert.rejects(applyDocxOps(STANDARD, usualOps().slice(0, 2), view.byRef, { signal: AbortSignal.abort() }), (err) => err?.name === 'AbortError');
  assert.equal((await applyDocxOps(STANDARD, usualOps().slice(0, 2), view.byRef)).applied, 2);
  // An apply that fails outright is a failure, not "too long".
  const broken = setup({ options: { apply: async () => { throw new Error('Edited file failed structural checks: a table cell has no paragraph'); } } });
  await assert.rejects(broken.run(usualInput()), /^Error: Edited file failed structural checks/);
  assert.deepEqual(actions(broken).map((a) => a.outcome), ['failed']);
  assert.equal(broken.supabase.calls.upload.length, 0);
});

test('one fill at a time: a second fill while one runs is refused in one sentence, recorded as refused, and runs once the first is done; a failed fill releases the lock', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (bytes, ops, byRef, opts) => { await gate; return applyDocxOps(bytes, ops, byRef, opts); };
  const first = setup({ options: { apply: slow } });
  const second = setup();
  assert.equal(isFilling(), false);
  const running = first.run(usualInput());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(isFilling(), true);
  await assert.rejects(second.run(usualInput()), new RegExp(`^Error: ${BUSY_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  assert.equal(second.supabase.calls.upload.length, 0);
  assert.deepEqual(actions(second).map((a) => a.outcome), ['refused']);
  assert.equal(second.caps.released, 1);
  release();
  assert.match(await running, /^Drafted /);
  assert.equal(isFilling(), false);
  assert.equal(first.supabase.calls.upload.length, 1);
  // The same caller again, now that the first is done.
  const again = setup();
  assert.match(await again.run(usualInput()), /^Drafted /);
  // A fill that throws inside the heavy section leaves the lock open.
  const broken = setup({ options: { apply: async () => { throw new Error('Edited file failed structural checks: x'); } } });
  await assert.rejects(broken.run(usualInput()), /structural checks/);
  assert.equal(isFilling(), false);
  assert.match(BUSY_SENTENCE, /Another fill is running on the Hub/);
});

test('a character Word cannot read in a change never reaches the file: the text lands without it', async () => {
  const s = setup();
  const out = await s.run(usualInput({ ops: [
    { op: 'replace', p: at(P_PERIOD), expected: P_PERIOD, text: 'The Concession Period is thirty (30)\u0001 years from the Effective\u0000 Date.' },
    { op: 'comment', p: at(P_LAW), expected: P_LAW, text: 'Confirm\u000B the law.' },
  ] }));
  assert.match(out.split('\n')[1], /^Changes: 2 of 2 made/);
  const up = s.supabase.calls.upload[0];
  const xml = partOf(up.body, 'word/document.xml');
  const comments = partOf(up.body, 'word/comments.xml');
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(comments), 'no control character in the file');
  assert.match(textOf(xml), /The Concession Period is thirty \(30\) years from the Effective Date\./);
  assert.match(comments, /Confirm the law\./);
});

test('the format gate: a fill that drifts from the standard (a typed clause number) is refused with the list of what differs, recorded as refused, nothing uploaded; FORMAT_GATE=report files it with the list as a warning', async () => {
  const typed = [{ op: 'insert_after', p: at(P_PERIOD), expected: P_PERIOD, text: '1.1 The Concession Period may be extended by agreement.' }];
  const before = process.env.FORMAT_GATE;
  try {
    delete process.env.FORMAT_GATE;
    const s = setup();
    await assert.rejects(s.run(usualInput({ ops: typed })), (err) => {
      assert.match(err.message, /^The format check found that this file differs from the firm's standard \(Standard Concession Agreement \[AKLA\]\):\n- 1 paragraph starts with a typed clause number instead of Word's numbering \(for example "1\.1 The Concession Period may be extended by agreement\."\)\nNothing was saved, because a draft is filed only in the firm's own format;/);
      assert.match(err.message, /The standard is unchanged\.$/);
      return true;
    });
    assert.equal(s.supabase.calls.upload.length, 0, 'nothing was uploaded');
    assert.equal(s.supabase.calls.rpc.length, 0, 'nothing was saved');
    assert.deepEqual(actions(s).map((r) => r.outcome), ['refused']);
    assert.equal(s.caps.released, 1);
    assert.equal(isFilling(), false, 'the lock is free');
    assert.ok(s.lines.some((l) => /fill_standard_to_project: format drift \(refused\)/.test(l)), 'the refusal is logged');

    process.env.FORMAT_GATE = 'report';
    const r = setup();
    const out = await r.run(usualInput({ ops: typed }));
    assert.equal(r.supabase.calls.upload.length, 1, 'report mode files it');
    assert.deepEqual(actions(r).map((x) => x.outcome), ['saved']);
    assert.match(out, /\nWarning: the format differs from the firm's standard \(Standard Concession Agreement \[AKLA\]\), and the file was saved anyway because the format check is set to report only:\n- 1 paragraph starts with a typed clause number/);
  } finally {
    if (before === undefined) delete process.env.FORMAT_GATE; else process.env.FORMAT_GATE = before;
  }
});

test('the format gate: the project-name blank in the running header (as in the RFP standard) is filled and filed; the header lines the fill targets may change their words', async () => {
  const HNS = NS + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const ARIAL = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="20"/></w:rPr>';
  const hpara = (text) => `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r>${ARIAL}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const standard = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<w:document ${HNS}><w:body>${BODY}<w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`),
    'word/header1.xml': strToU8(`<w:hdr ${HNS}>${hpara('VOLUME I: INSTRUCTION TO BIDDERS')}${hpara('[●]')}</w:hdr>`),
  }, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) });
  const v = inspectDocx(standard, { budget: Infinity });
  const ref = (text) => [...v.byRef.values()].find((r) => r.exactText === text);
  assert.equal(ref('[●]').part, 'word/header1.xml');
  const header = (bytes) => partOf(bytes, 'word/header1.xml');
  const ops = [
    { op: 'replace', p: ref(P_PERIOD).index, expected: P_PERIOD, text: 'The Concession Period is thirty (30) years from the Effective Date.' },
    { op: 'replace', p: ref('[●]').index, expected: '[●]', text: 'Hyderabad Bypass Project' },
  ];
  const s = setup({ standard });
  const out = await s.run(usualInput({ ops, templateHash: sha256(standard) }));
  assert.match(out, /\nFormat matches the firm's standard \(Standard Concession Agreement \[AKLA\]\)\.\n/);
  assert.equal(s.supabase.calls.upload.length, 1);
  assert.equal(textOf(header(s.supabase.calls.upload[0].body)), 'VOLUME I: INSTRUCTION TO BIDDERSHyderabad Bypass Project');
  // The title line is not a blank, but this fill asked to change it: its words may change.
  const retitle = { op: 'replace', p: ref('VOLUME I: INSTRUCTION TO BIDDERS').index, expected: 'VOLUME I: INSTRUCTION TO BIDDERS', text: 'VOLUME I: INSTRUCTIONS TO BIDDERS' };
  const t = setup({ standard });
  const out2 = await t.run(usualInput({ ops: [...ops, retitle], templateHash: sha256(standard) }));
  assert.match(out2, /\nFormat matches the firm's standard/);
  assert.equal(textOf(header(t.supabase.calls.upload[0].body)), 'VOLUME I: INSTRUCTIONS TO BIDDERSHyderabad Bypass Project');
});

test('when no change at all can be made nothing is saved: the reasons are given, recorded as refused', async () => {
  const s = setup();
  await assert.rejects(s.run(usualInput({ ops: usualOps().slice(3) })), /^Error: None of the 2 changes could be made, so nothing was saved; the standard is unchanged\. - Changed ¶\d+: The Performance Security is PKR 500,000,000\. — Expected paragraph text does not match the source; no change was made\. - Changed ¶99: Nothing there — Paragraph was not supplied to this turn; request that section first\. Open the standard again and quote each paragraph's exact current text in expected\.$/);
  assert.equal(s.supabase.calls.upload.length, 0);
  assert.deepEqual(actions(s).map((a) => a.outcome), ['refused']);
  assert.equal(s.caps.released, 1);
});

test('a refusal from the database takes the upload back: the sentence, no object left, recorded as failed, the standard untouched', async () => {
  const s = setup({ saveFails: 'Forbidden' });
  await assert.rejects(s.run(usualInput()), /^Error: Only approved members of the firm can save into a project\.$/);
  assert.equal(s.supabase.calls.upload.length, 1);
  assert.equal(s.supabase.calls.remove.length, 1);
  assert.deepEqual(s.supabase.calls.remove[0], { bucket: BUCKET, paths: [s.supabase.calls.upload[0].path] });
  assert.equal(s.supabase.objects.size, 0, 'no orphan in the bucket');
  assert.equal((s.tables.document_versions ?? []).filter((v) => v.id === NEW_V).length, 0, 'no version row');
  assert.deepEqual(standardWrites(s), []);
  assert.deepEqual(actions(s).map((a) => a.outcome), ['failed']);
  assert.equal(s.caps.released, 1);
  // A colleague's newer version: refused by the database, the upload taken back.
  const stale = setup();
  stale.tables.document_versions.push({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', matter_document_id: D1, version_number: 2, storage_path: 'y', file_name: 'CA-v2.docx' });
  stale.supabase.rpc = async (name, args) => ({ data: null, error: { message: 'A newer document version exists. Reopen the latest version before saving these edits.' } });
  await assert.rejects(stale.run(usualInput({ matterDocumentId: D1 })), /^Error: A newer version exists: a colleague saved one in the meantime/);
  assert.equal(stale.supabase.objects.size, 0);
  assert.deepEqual(actions(stale).map((a) => a.outcome), ['failed']);
});

test('a type without a Word standard, an unknown type, an unknown project and a read-only sign-in are each one sentence with nothing read or written', async () => {
  const s = setup();
  await assert.rejects(s.run(usualInput({ documentTypeId: T_NDA })), /^Error: There is no Word standard for Non-Disclosure Agreement to fill; save_draft_to_project files a draft in the house format instead\.$/);
  await assert.rejects(s.run(usualInput({ documentTypeId: T_NONE })), /There is no Word standard for Board Resolution to fill/);
  await assert.rejects(s.run(usualInput({ documentTypeId: 'nope' })), /documentTypeId must be a document type id/);
  await assert.rejects(s.run(usualInput({ projectId: '99999999-9999-4999-8999-999999999999' })), /There is no project with that id/);
  await assert.rejects(s.run(usualInput({ title: '   ' })), /A title for the new document is needed/);
  assert.equal(s.supabase.calls.download.length, 0);
  assert.equal(s.supabase.calls.upload.length, 0);
  assert.equal(actions(s).length, 0);
  assert.equal(s.caps.released, s.caps.checked, 'every handle released');
  await assert.rejects(s.run(usualInput(), ctxOf({ scope: READ_SCOPE, canWrite: false, recheck: async () => ({ userId: USER, scope: READ_SCOPE, tokenId: 't1' }) })), new RegExp(READ_ONLY_REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(s.supabase.calls.download.length, 0);
});

test('a record that fails after the save landed is said in the reply, never thrown', async () => {
  const s = setup();
  const realRecord = s.list.find((x) => x.name === FILL_TOOL);
  // Make the record's insert fail only for the saved row.
  const insert = s.supabase.from;
  s.supabase.from = (table) => {
    const q = insert(table);
    if (table === 'connector_actions') {
      const orig = q.insert;
      q.insert = (row) => { if (row.outcome === 'saved') { const bad = { then: (ok) => Promise.resolve({ data: null, error: { message: 'down' } }).then(ok) }; return bad; } return orig(row); };
    }
    return q;
  };
  const out = await realRecord.run(usualInput(), ctxOf());
  assert.match(out, /^Drafted /);
  assert.ok(out.includes(UNRECORDED_LINE));
  assert.equal(s.supabase.calls.upload.length, 1);
  assert.ok(s.lines.some((l) => /the record could not be written: The write could not be recorded: down/.test(l)));
});

test('changesLines reads describeResults: counts, then every refused change with its reason', () => {
  const lines = changesLines([
    { i: 0, kind: 'replace', p: 2, text: 'new', status: 'applied' },
    { i: 1, kind: 'comment', p: 3, text: 'note', status: 'applied' },
    { i: 2, kind: 'delete', p: 4, status: 'skipped', reason: 'Expected paragraph text does not match the source; no change was made.' },
  ]);
  assert.deepEqual(lines, [
    'Changes: 2 of 3 made (1 in the text, 1 margin comment); 1 could not be made.',
    'Could not be made (the slot is as it was in the standard):',
    '- Deleted ¶4 — Expected paragraph text does not match the source; no change was made.',
  ]);
  assert.deepEqual(changesLines([{ i: 0, kind: 'replace', p: 2, text: 'new', status: 'applied' }]), ['Changes: 1 of 1 made (1 in the text, 0 margin comments); 0 could not be made.']);
});
