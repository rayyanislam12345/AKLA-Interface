// Piece 2.1 of the connector: save_note_to_project and save_draft_to_project
// (connector/tools/saves.js). Against a stub database and a stub Word
// renderer: both tools are write tools with the foundation's annotations;
// a note lands as a Markdown file and a draft as a house-format Word file,
// as a new document or the next version of one; the caps are checked
// first and every attempt is recorded, never with the text; a stale
// expected version, an over-long text, a failed render and a database
// refusal each come back as one sentence with nothing left behind; every
// result carries the ids and the Hub pages. No network, no Python.
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { WRITE } from '../connector/app.js';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES } from '../connector/tools.js';
import { DEFAULT_SCOPE, READ_ONLY_REFUSAL } from '../connector/oauth.js';
import { BUCKET, SIGN_IN_ENDED_SENTENCE, createProjectWrites } from '../connector/projectWrites.js';
import saves, { createSaveTools, markdownOf, formatCheckLine, MAX_MARKDOWN_CHARS, RENDER_TIMEOUT_MS, DOCX_MIME, NOTE_TOOL, DRAFT_TOOL } from '../connector/tools/saves.js';

const USER = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const V2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NEW_V = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const T1 = '12121212-1212-4121-8121-121212121212';
const CLOCK = Date.parse('2026-10-20T09:00:00Z');
const HUB = 'https://hub.test';

// ---------------------------------------------------------------------------
// A Supabase stub for the write path (as connector-2.0-writes.test.js has
// it): tables with the filters the modules use, a bucket that remembers
// uploads and removals, an rpc that plays the database's save.

function fakeSupabase({ tables = {}, rpc = async () => ({ data: null, error: null }), errors = {} } = {}) {
  const calls = { upload: [], remove: [], rpc: [], insert: [], from: [] };
  const objects = new Set();
  const chain = (table) => {
    calls.from.push(table);
    let rows = [...(tables[table] ?? [])];
    let single = false;
    let inserted = null;
    const q = {
      select() { return q; }, order(col, { ascending } = {}) { rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending === false ? -1 : 1)); return q; },
      limit(n) { rows = rows.slice(0, n); return q; }, range() { return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      in(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      gte(col, val) { rows = rows.filter((r) => r[col] >= val); return q; },
      maybeSingle() { single = true; return q; },
      insert(row) { inserted = row; calls.insert.push({ table, row }); (tables[table] ??= []).push(row); return q; },
      then(ok, bad) { return Promise.resolve(errors[table] ? { data: null, error: errors[table] } : { data: inserted ? null : single ? rows[0] ?? null : rows, error: null }).then(ok, bad); },
    };
    return q;
  };
  return {
    calls, objects, tables,
    from: chain,
    rpc: async (name, args) => { calls.rpc.push({ name, args }); return rpc(name, args, { objects, tables }); },
    storage: {
      from: (bucket) => ({
        upload: async (path, body, opts) => { calls.upload.push({ bucket, path, body, opts }); objects.add(path); return { data: { path }, error: null }; },
        remove: async (paths) => { calls.remove.push({ bucket, paths }); for (const p of paths) objects.delete(p); return { data: paths, error: null }; },
        download: async () => ({ data: null, error: { message: 'none' } }),
      }),
    },
  };
}

// The database's save as the migration writes it: the staged object must
// exist, a next version must be on the project and on the expected
// version; the next number otherwise.
function scriptedSave(t) {
  return async (name, args, { objects }) => {
    assert.equal(name, 'save_document_version_as');
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
  matters: [{ id: P1, name: 'M6 Motorway', status: 'active', client: { name: 'NHA' } }, { id: P2, name: 'KPT Corridor', status: 'active' }],
  matter_documents: [{ id: D1, title: 'Concession Agreement', matter_id: P1, document_type_id: T1 }],
  document_versions: [
    { id: V1, matter_document_id: D1, version_number: 1, storage_path: `${P1}/${D1}/x-CA.docx`, file_name: 'CA-v1.docx' },
    { id: V2, matter_document_id: D1, version_number: 2, storage_path: `${P1}/${D1}/y-CA.docx`, file_name: 'CA-v2.docx' },
  ],
  document_types: [{ id: T1, name: 'Concession Agreement' }],
  connector_actions: [],
});

// A rendered Word file, as aklaRender.renderAklaDocx answers: the bytes,
// the renderer's stderr lines and the house-format check.
const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const PASSED = { status: 'checked', findings: [], sections: 3, comments: 2 };
function stubRender({ result = { bytes: DOCX_BYTES, warnings: [], check: PASSED }, fail = null } = {}) {
  const calls = [];
  const render = async (args) => { calls.push(args); if (fail) throw fail instanceof Error ? fail : new Error(fail); return typeof result === 'function' ? result(args) : result; };
  return { render, calls };
}

const ctxOf = (extra = {}) => ({ userId: USER, clientId: 'akh_c_test', scope: DEFAULT_SCOPE, tokenId: 't1', canWrite: true, recheck: async () => ({ userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' }), ...extra });

/** The two tools through the registry, with real projectWrites over the stub database and a stub renderer. */
function setup({ tables = fixtures(), rpc = null, errors = {}, renderer = stubRender() } = {}) {
  const t = { tables };
  const supabase = fakeSupabase({ tables, rpc: rpc ?? scriptedSave(t), errors });
  const lines = [];
  const log = (l) => lines.push(l);
  const writes = createProjectWrites({ supabase, hubUrl: HUB, now: () => new Date(CLOCK), log });
  const modules = [{ file: 'saves.js', tools: (deps) => createSaveTools(deps, { render: renderer.render }) }];
  const list = createHubTools({ supabase, voyageKey: 'v', library: { searchLaw: async () => [], readActSection: async () => { throw new Error('no'); }, searchPrecedentsTool: async () => [], searchProject: async () => [] }, readFile: async () => ({ blocks: [] }), log, hubUrl: `${HUB}/`, modules, writes, now: () => CLOCK });
  const byName = Object.fromEntries(list.map((x) => [x.name, x]));
  const run = (name, input, ctx = ctxOf()) => byName[name].run(input, ctx);
  return { supabase, tables, lines, writes, list, byName, run, renderer };
}

const actions = (s) => s.tables.connector_actions;

// ---------------------------------------------------------------------------
// Shape

test('saves.js adds two write tools after the slice 1 modules, each with the foundation\'s annotations and a lawyer\'s description', async () => {
  const loaded = await loadToolModules();
  assert.ok(loaded.some((m) => m.file === 'saves.js'), 'the module is in the directory the connector loads');
  const { list } = setup();
  assert.deepEqual(list.map((x) => x.name), [...BUILT_IN_TOOL_NAMES, NOTE_TOOL, DRAFT_TOOL]);
  assert.equal(NOTE_TOOL, 'save_note_to_project');
  assert.equal(DRAFT_TOOL, 'save_draft_to_project');
  for (const name of [NOTE_TOOL, DRAFT_TOOL]) {
    const tool = list.find((x) => x.name === name);
    assert.equal(tool.write, true);
    assert.deepEqual(tool.annotations, WRITE, 'readOnlyHint false, destructiveHint true until a live test says otherwise (owner decision 5)');
    assert.ok(tool.description.length > 200, `${name} says what it does, when to use it and what it changes`);
    assert.match(tool.description, /NEW version, never over one/);
    assert.match(tool.description, /claude\.ai asks the lawyer/);
    assert.match(tool.description, /recorded against the lawyer/);
    assert.match(tool.description, /not legal approval/);
    assert.match(tool.description, /600,000 characters/);
    for (const k of ['projectId', 'title', 'matterDocumentId', 'expectedVersionId', 'label']) assert.ok(tool.inputSchema[k] instanceof z.ZodType, `${name} takes ${k}`);
  }
  assert.ok(list.find((x) => x.name === NOTE_TOOL).inputSchema.text instanceof z.ZodType);
  assert.match(list.find((x) => x.name === NOTE_TOOL).description, /save_draft_to_project instead/);
  const draft = list.find((x) => x.name === DRAFT_TOOL);
  assert.ok(draft.inputSchema.markdown instanceof z.ZodType);
  assert.ok(draft.inputSchema.documentTypeId instanceof z.ZodType);
  assert.match(draft.description, /A4, Arial 11/);
  assert.match(draft.description, /save_note_to_project saves the same text/);
  // The default export is the same two tools with the real renderer behind them; the registry accepts it beside the slice 1 modules.
  const real = createHubTools({ supabase: fakeSupabase(), voyageKey: 'v', log: () => {}, modules: [...loaded.filter((m) => m.file !== 'saves.js'), saves], writes: {} });
  assert.deepEqual(real.slice(-2).map((x) => x.name), [NOTE_TOOL, DRAFT_TOOL]);
  assert.equal(MAX_MARKDOWN_CHARS, 600_000);
  assert.equal(RENDER_TIMEOUT_MS, 60_000);
});

test('markdownOf and formatCheckLine: the cap, an empty text, and the check in one line', () => {
  assert.equal(markdownOf('﻿# Memo\n', 'text'), '# Memo\n', 'a byte-order mark is dropped');
  assert.throws(() => markdownOf('   \n', 'text'), /^Error: There is nothing to save: text is empty\.$/);
  assert.throws(() => markdownOf(undefined, 'markdown'), /nothing to save: markdown is empty/);
  assert.equal(markdownOf('x'.repeat(MAX_MARKDOWN_CHARS), 'text').length, MAX_MARKDOWN_CHARS);
  assert.throws(() => markdownOf('x'.repeat(MAX_MARKDOWN_CHARS + 1), 'markdown'), /^Error: The markdown is 600,001 characters; a save takes at most 600,000\. Save it in parts, or shorten it\.$/);
  assert.equal(formatCheckLine(PASSED), 'House format check: passed (3 numbered sections, 2 AKLA comments).');
  assert.equal(formatCheckLine({ status: 'checked', findings: [], sections: 1, comments: 1 }), 'House format check: passed (1 numbered section, 1 AKLA comment).');
  assert.match(formatCheckLine({ status: 'needs_review', findings: ['The page is not A4.', 'Body text is not set in Arial.'], sections: 0, comments: 0 }), /^House format check: needs review\. The page is not A4\. Body text is not set in Arial\. The file is saved as rendered/);
  assert.equal(formatCheckLine(null), 'House format check: not run.');
  const noted = formatCheckLine(PASSED, ['w1', ' ', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']);
  assert.match(noted, /\nRenderer notes: w1 \| w2 \| w3 \| w4 \| w5 \| and 2 more$/);
});

// ---------------------------------------------------------------------------
// save_note_to_project

test('a note becomes v1 of a new document: caps checked first, the Markdown uploaded under the site\'s path, the version saved as the lawyer\'s own, one record, ids and Hub pages back', async () => {
  const s = setup();
  let rechecked = 0;
  const ctx = ctxOf({ recheck: async () => { rechecked += 1; return { userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' }; } });
  const text = '# Notes on the term sheet\n\n1. The term is thirty (30) years.\n';
  const out = await s.run(NOTE_TOOL, { projectId: P1, title: '  Notes on the term sheet ', text }, ctx);
  assert.equal(rechecked, 1, 'the sign-in was checked afresh before anything else');
  // The upload: the project, a new document id, the stem from the title, .md as Markdown.
  assert.equal(s.supabase.calls.upload.length, 1);
  const up = s.supabase.calls.upload[0];
  assert.equal(up.bucket, BUCKET);
  assert.match(up.path, new RegExp(`^${P1}/[0-9a-f-]{36}/[0-9a-f-]{36}-Notes-on-the-term-sheet\\.md$`));
  assert.equal(Buffer.from(up.body).toString('utf8'), text, 'the text as written, UTF-8');
  assert.deepEqual(up.opts, { contentType: 'text/markdown', upsert: false });
  // The RPC: as the lawyer, a new document, not AI-generated, the date label.
  const args = s.supabase.calls.rpc[0].args;
  assert.equal(args.p_user_id, USER);
  assert.equal(args.p_create_new, true);
  assert.equal(args.p_document_type_id, null);
  assert.equal(args.p_title, 'Notes on the term sheet');
  assert.equal(args.p_extension, 'md');
  assert.equal(args.p_is_ai_generated, false, 'owner decision 1: the lawyer\'s own filing');
  assert.equal(args.p_label, 'Saved from claude.ai — 20 October 2026');
  // One record, with the ids and never the text.
  assert.equal(actions(s).length, 1);
  const row = actions(s)[0];
  assert.equal(row.user_id, USER);
  assert.equal(row.tool, NOTE_TOOL);
  assert.equal(row.project_id, P1);
  assert.equal(row.document_id, args.p_document_id);
  assert.equal(row.version_id, NEW_V);
  assert.equal(row.label, 'Saved from claude.ai — 20 October 2026');
  assert.equal(row.outcome, 'saved');
  assert.ok(!JSON.stringify(row).includes('term sheet'), 'never the document\'s text');
  // The reply.
  assert.equal(out.split('\n')[0], `Saved "Notes on the term sheet" as v1 (Notes-on-the-term-sheet-v1.md), a new document on M6 Motorway, labelled "Saved from claude.ai — 20 October 2026".`);
  assert.match(out, new RegExp(`\ndocumentId: ${args.p_document_id}\nversionId: ${NEW_V}\nOpen in Hub: ${HUB}/ai/d/${NEW_V}\nProject M6 Motorway — Open in Hub: ${HUB}/ai/p/${P1}\n`));
  assert.match(out, /\nOn file; the Hub is reading it now\. Call get_document_summary on the version in about a minute\.\n/);
  assert.match(out, /Filed as the lawyer's own version \(not marked AI-generated\).*filing is not legal approval\.$/);
  assert.ok(!/House format check/.test(out), 'a note is not rendered, so there is no format check');
  assert.ok(!/supabase\.co|\/storage\/v1\//.test(out), 'Hub pages only, no storage links');
  // The caller's label is kept, with the source added.
  await s.run(NOTE_TOOL, { projectId: P2, title: 'Memo', text: 'Short.', label: '  For partner  review ' });
  assert.equal(s.supabase.calls.rpc[1].args.p_label, 'For partner review — saved from claude.ai');
  assert.equal(actions(s)[1].label, 'For partner review — saved from claude.ai');
  assert.equal(actions(s)[1].project_id, P2);
  // A title pasted over two lines (claude.ai does this) saves: the file
  // name and the Hub's title are the one-line form, and they agree.
  const multi = await s.run(NOTE_TOOL, { projectId: P2, title: 'Notes on the\n   term sheet\r\n(second read)', text: 'Short.' });
  assert.match(multi, /^Saved "Notes on the term sheet \(second read\)" as v1 \(Notes-on-the-term-sheet-second-read-v1\.md\)/);
  assert.equal(s.supabase.calls.rpc[2].args.p_title, 'Notes on the term sheet (second read)');
  assert.match(s.supabase.calls.upload[2].path, /-Notes-on-the-term-sheet-second-read\.md$/);
  assert.equal(actions(s)[2].outcome, 'saved');
});

test('a note as the next version of an existing document: the document\'s own title when none is given, the expected-version guard, a stale one refused and recorded with nothing uploaded', async () => {
  const s = setup();
  // No title: the document's.
  const out = await s.run(NOTE_TOOL, { projectId: P1, text: 'Revised notes.', matterDocumentId: D1, expectedVersionId: V2 });
  assert.match(out, /^Saved "Concession Agreement" as v3 \(Concession-Agreement-v3\.md\), its next version on M6 Motorway, labelled/);
  const args = s.supabase.calls.rpc[0].args;
  assert.equal(args.p_create_new, false);
  assert.equal(args.p_document_id, D1);
  assert.equal(args.p_expected_version_id, V2);
  assert.equal(args.p_document_type_id, T1, 'the document keeps its type');
  assert.match(s.supabase.calls.upload[0].path, new RegExp(`^${P1}/${D1}/[0-9a-f-]{36}-Concession-Agreement\\.md$`));
  assert.deepEqual([actions(s)[0].document_id, actions(s)[0].version_id, actions(s)[0].outcome], [D1, NEW_V, 'saved']);
  // The caller read v2, but v3 now exists: refused before any upload, and the attempt is on the record.
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, text: 'More.', matterDocumentId: D1, expectedVersionId: V2 }), /^Error: A newer version exists \(v3\): read it before saving the next one\.$/);
  assert.equal(s.supabase.calls.upload.length, 1);
  assert.equal(s.supabase.calls.rpc.length, 1);
  assert.deepEqual([actions(s)[1].tool, actions(s)[1].document_id, actions(s)[1].version_id, actions(s)[1].outcome], [NOTE_TOOL, D1, null, 'refused']);
  // Without an expected version the latest at the moment of saving is
  // taken; a given title names the file only, and the reply names the
  // document as the Hub still lists it (the function ignores p_title for
  // a next version; rename_document is the way to retitle).
  const next = await s.run(NOTE_TOOL, { projectId: P1, text: 'v4.', matterDocumentId: D1, title: 'Concession Agreement (notes)' });
  assert.match(next, /^Saved "Concession Agreement" as v4 \(Concession-Agreement-notes-v4\.md\), its next version on M6 Motorway/);
  assert.equal(s.supabase.calls.rpc[1].args.p_expected_version_id, NEW_V);
  assert.match(s.byName[NOTE_TOOL].inputSchema.title.description, /title of a NEW document.*rename_document changes it.*only names the file/);
  assert.match(s.byName[DRAFT_TOOL].inputSchema.title.description, /title of a NEW document.*rename_document changes it.*names the file and goes on the banner/);
  // A document on another project, an unknown document, an expected version with no document, bad ids.
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P2, text: 'x', matterDocumentId: D1 }), /^Error: That document is not on KPT Corridor\.$/);
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, text: 'x', matterDocumentId: V1 }), /There is no project document with that id/);
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, text: 'x', expectedVersionId: V2, title: 'T' }), /expectedVersionId only makes sense with matterDocumentId/);
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, text: 'x', matterDocumentId: 'doc-1' }), /matterDocumentId must be a document id/);
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, text: 'x', matterDocumentId: D1, expectedVersionId: 'v2' }), /expectedVersionId must be a document version id/);
  assert.equal(s.supabase.calls.upload.length, 2, 'nothing more was uploaded');
  assert.equal(actions(s).length, 3, 'a refusal of the input is not a write and is not recorded');
});

test('a note is refused in one sentence, before anything is written, when the input is bad, the project is unknown, the cap is reached or the sign-in cannot write', async () => {
  const s = setup();
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, title: 'T', text: '' }), /^Error: There is nothing to save: text is empty\.$/);
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, title: 'T', text: 'x'.repeat(MAX_MARKDOWN_CHARS + 1) }), /^Error: The text is 600,001 characters; a save takes at most 600,000\./);
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, text: 'A note with no title.' }), /^Error: A title for the new document is needed/);
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, title: '   ', text: 'x' }), /A title for the new document is needed/);
  await assert.rejects(s.run(NOTE_TOOL, { projectId: 'm6', title: 'T', text: 'x' }), /projectId must be a project id/);
  await assert.rejects(s.run(NOTE_TOOL, { projectId: V1, title: 'T', text: 'x' }), /There is no project with that id/);
  // The sign-in: read-only (the wrapper's floor, then checkCaps), ended, another person's.
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, title: 'T', text: 'x' }, ctxOf({ scope: 'hub:read', canWrite: false })), new RegExp(READ_ONLY_REFUSAL.slice(0, 30)));
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, title: 'T', text: 'x' }, ctxOf({ recheck: async () => ({ userId: USER, scope: 'hub:read' }) })), new RegExp(READ_ONLY_REFUSAL.slice(0, 30)));
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, title: 'T', text: 'x' }, ctxOf({ recheck: async () => null })), new RegExp(SIGN_IN_ENDED_SENTENCE.slice(0, 40)));
  assert.equal(s.supabase.calls.upload.length, 0);
  assert.equal(s.supabase.calls.rpc.length, 0);
  assert.equal(actions(s).length, 0);
  // The hourly cap: 30 rows in the hour, the 31st save is refused, and the text is never looked at.
  const capped = setup({ tables: { ...fixtures(), connector_actions: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, user_id: USER, tool: NOTE_TOOL, outcome: 'saved', created_at: new Date(CLOCK - i * 60_000 - 1000).toISOString() })) } });
  await assert.rejects(capped.run(NOTE_TOOL, { projectId: P1, title: 'T', text: 'x' }), /^Error: You have saved 30 times from claude\.ai in the last hour, which is the limit; try again in a while, or save from the Hub\.$/);
  assert.equal(capped.supabase.calls.upload.length, 0);
  assert.equal(actions(capped).length, 30, 'a refusal at the cap adds no row');
  assert.ok(!capped.supabase.calls.from.includes('matters'), 'the cap is checked before the project is read');
  // Thirty attempts the renderer failed and thirty stale saves refused in the hour wrote nothing: the next save goes through.
  const tried = setup({ tables: { ...fixtures(), connector_actions: Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, user_id: USER, tool: DRAFT_TOOL, outcome: i % 2 ? 'failed' : 'refused', created_at: new Date(CLOCK - i * 30_000 - 1000).toISOString() })) } });
  assert.match(await tried.run(NOTE_TOOL, { projectId: P1, title: 'T', text: 'x' }), /^Saved "T" as v1/);
  assert.equal(actions(tried).length, 61);
  // Two saves fired in one turn at the 29th row: one lands, the other is refused, and the refusal is not recorded.
  const edge = setup({ tables: { ...fixtures(), connector_actions: Array.from({ length: 29 }, (_, i) => ({ id: `a${i}`, user_id: USER, tool: NOTE_TOOL, outcome: 'saved', created_at: new Date(CLOCK - i * 60_000 - 1000).toISOString() })) } });
  const pair = await Promise.allSettled([edge.run(NOTE_TOOL, { projectId: P1, title: 'One', text: 'x' }), edge.run(NOTE_TOOL, { projectId: P1, title: 'Two', text: 'y' })]);
  assert.deepEqual(pair.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.match(pair[1].reason.message, /^You have saved 30 times from claude\.ai in the last hour/);
  assert.equal(edge.supabase.calls.upload.length, 1);
  assert.equal(actions(edge).length, 30);
  // The handle is released once the save is recorded: with the 30th row now in the table, the next is refused by the table alone, and the in-flight entry is not double-counted later.
  await assert.rejects(edge.run(NOTE_TOOL, { projectId: P1, title: 'Three', text: 'z' }), /saved 30 times/);
});

test('when the database refuses the save, the upload is taken back, the attempt is recorded as failed and the reason is one sentence', async () => {
  const s = setup({ rpc: async () => ({ data: null, error: { message: 'Forbidden' } }) });
  await assert.rejects(s.run(NOTE_TOOL, { projectId: P1, title: 'T', text: 'x' }), /^Error: Only approved members of the firm can save into a project\.$/);
  assert.equal(s.supabase.calls.upload.length, 1);
  assert.deepEqual(s.supabase.calls.remove, [{ bucket: BUCKET, paths: [s.supabase.calls.upload[0].path] }]);
  assert.deepEqual([actions(s)[0].tool, actions(s)[0].project_id, actions(s)[0].document_id, actions(s)[0].version_id, actions(s)[0].outcome], [NOTE_TOOL, P1, null, null, 'failed']);
  // A record that cannot be written does not hide the save's own outcome.
  const quiet = setup({ errors: { connector_actions: { message: 'relation "connector_actions" does not exist' } } });
  await assert.rejects(quiet.run(NOTE_TOOL, { projectId: P1, title: 'T', text: 'x' }), /The saving limit could not be checked: relation "connector_actions" does not exist/, 'without the migration nothing is saved at all');
  assert.equal(quiet.supabase.calls.upload.length, 0);
});

// ---------------------------------------------------------------------------
// save_draft_to_project

test('a draft is rendered to the house-format Word file and saved as v1 of a new document, with the format check in the reply and the type when one is named', async () => {
  const renderer = stubRender({ result: { bytes: DOCX_BYTES, warnings: ['python-docx: one note'], check: PASSED } });
  const s = setup({ renderer });
  const markdown = '# Notes on the Concession Agreement\n\n## Term\n\nThe term is [●] years. [[AKLA Comment: confirm with the Authority]]\n';
  const out = await s.run(DRAFT_TOOL, { projectId: P1, title: 'Notes on the Concession Agreement', markdown, documentTypeId: T1, label: 'First draft' });
  // The renderer got the Markdown, the title for the banner and the timeout; the bytes it made were uploaded as a .docx.
  assert.deepEqual(renderer.calls, [{ markdown, title: 'Notes on the Concession Agreement', timeoutMs: RENDER_TIMEOUT_MS }]);
  assert.equal(s.supabase.calls.upload.length, 1);
  const up = s.supabase.calls.upload[0];
  assert.match(up.path, new RegExp(`^${P1}/[0-9a-f-]{36}/[0-9a-f-]{36}-Notes-on-the-Concession-Agreement\\.docx$`));
  assert.deepEqual([...up.body], [...DOCX_BYTES]);
  assert.deepEqual(up.opts, { contentType: DOCX_MIME, upsert: false });
  const args = s.supabase.calls.rpc[0].args;
  assert.equal(args.p_create_new, true);
  assert.equal(args.p_document_type_id, T1);
  assert.equal(args.p_extension, 'docx');
  assert.equal(args.p_is_ai_generated, false);
  assert.equal(args.p_label, 'First draft — saved from claude.ai');
  assert.deepEqual([actions(s)[0].tool, actions(s)[0].outcome, actions(s)[0].version_id], [DRAFT_TOOL, 'saved', NEW_V]);
  assert.ok(!JSON.stringify(actions(s)[0]).includes('Concession'), 'the record carries ids and the label, not the draft');
  assert.match(out, /^Saved "Notes on the Concession Agreement" as v1 \(Notes-on-the-Concession-Agreement-v1\.docx\), a new document on M6 Motorway, labelled "First draft — saved from claude\.ai"\.\n/);
  assert.match(out, new RegExp(`\nversionId: ${NEW_V}\nOpen in Hub: ${HUB}/ai/d/${NEW_V}\n`));
  assert.match(out, /\nHouse format check: passed \(3 numbered sections, 2 AKLA comments\)\.\nRenderer notes: python-docx: one note\n/);
  assert.match(out, /\nOn file; the Hub is reading it now\./);
  // A check that found something says so, and the file is still saved.
  const flagged = setup({ renderer: stubRender({ result: { bytes: DOCX_BYTES, warnings: [], check: { status: 'needs_review', findings: ['The page is not A4.'], sections: 2, comments: 0 } } }) });
  const out2 = await flagged.run(DRAFT_TOOL, { projectId: P1, title: 'T', markdown: '# T' });
  assert.match(out2, /\nHouse format check: needs review\. The page is not A4\. The file is saved as rendered/);
  assert.equal(flagged.supabase.calls.upload.length, 1);
  assert.equal(actions(flagged)[0].outcome, 'saved');
  // The type must exist and be an id; an existing document keeps its own type whatever is given.
  await assert.rejects(s.run(DRAFT_TOOL, { projectId: P1, title: 'T', markdown: '# T', documentTypeId: 'Concession Agreement' }), /documentTypeId must be a document type id/);
  await assert.rejects(s.run(DRAFT_TOOL, { projectId: P1, title: 'T', markdown: '# T', documentTypeId: V1 }), /There is no document type with that id/);
  assert.equal(renderer.calls.length, 1, 'nothing was rendered for a refused input');
  const next = await s.run(DRAFT_TOOL, { projectId: P1, markdown: '# CA v3', matterDocumentId: D1, expectedVersionId: V2, documentTypeId: V1 });
  assert.match(next, /^Saved "Concession Agreement" as v3 \(Concession-Agreement-v3\.docx\), its next version on M6 Motorway/);
  assert.equal(s.supabase.calls.rpc[1].args.p_document_type_id, T1);
  assert.equal(renderer.calls[1].title, 'Concession Agreement', 'the document\'s own title goes on the banner');
});

test('when the renderer fails, nothing is uploaded, the attempt is recorded as failed, and the reply offers save_note_to_project', async () => {
  const s = setup({ renderer: stubRender({ fail: 'The Word renderer took too long' }) });
  await assert.rejects(s.run(DRAFT_TOOL, { projectId: P1, title: 'T', markdown: '# T' }), /^Error: The Word file could not be made \(The Word renderer took too long\); nothing was saved\. save_note_to_project saves the same text as a Markdown file instead\.$/);
  assert.equal(s.supabase.calls.upload.length, 0);
  assert.equal(s.supabase.calls.rpc.length, 0);
  assert.deepEqual([actions(s)[0].tool, actions(s)[0].project_id, actions(s)[0].outcome], [DRAFT_TOOL, P1, 'failed']);
  assert.match(s.lines.find((l) => l.includes('renderer failed')) ?? '', /save_draft_to_project for 1111.*: the renderer failed: The Word renderer took too long/);
  // A renderer that answers with nothing is the same failure.
  const empty = setup({ renderer: stubRender({ result: { bytes: new Uint8Array(0), warnings: [], check: PASSED } }) });
  await assert.rejects(empty.run(DRAFT_TOOL, { projectId: P1, title: 'T', markdown: '# T' }), /could not be made \(the renderer returned nothing\)/);
  assert.equal(empty.supabase.calls.upload.length, 0);
  // Bad input is refused before the renderer is asked, and is not recorded.
  const r = stubRender();
  const t = setup({ renderer: r });
  await assert.rejects(t.run(DRAFT_TOOL, { projectId: P1, title: 'T', markdown: '' }), /^Error: There is nothing to save: markdown is empty\.$/);
  await assert.rejects(t.run(DRAFT_TOOL, { projectId: P1, title: 'T', markdown: 'x'.repeat(MAX_MARKDOWN_CHARS + 1) }), /The markdown is 600,001 characters/);
  await assert.rejects(t.run(DRAFT_TOOL, { projectId: P1, markdown: '# T' }), /A title for the new document is needed/);
  await assert.rejects(t.run(DRAFT_TOOL, { projectId: P1, title: 'T', markdown: '# T' }, ctxOf({ scope: 'hub:read', canWrite: false })), new RegExp(READ_ONLY_REFUSAL.slice(0, 30)));
  assert.equal(r.calls.length, 0);
  assert.equal(actions(t).length, 0);
  // A stale expected version is refused before the render (a minute's work for nothing), and the attempt is on the record.
  await assert.rejects(t.run(DRAFT_TOOL, { projectId: P1, markdown: '# T', matterDocumentId: D1, expectedVersionId: V1 }), /^Error: A newer version exists \(v2\): read it before saving the next one\.$/);
  assert.equal(r.calls.length, 0, 'nothing was rendered');
  assert.equal(t.supabase.calls.upload.length, 0);
  assert.deepEqual([actions(t).at(-1).tool, actions(t).at(-1).document_id, actions(t).at(-1).outcome], [DRAFT_TOOL, D1, 'refused']);
  // The database's own check still stands behind it: a version saved between the read and the save is refused by the function, after the render, with the upload taken back.
  let raced = false;
  const race = setup({ renderer: stubRender(), rpc: async () => { raced = true; return { data: null, error: { message: 'A newer document version exists. Reopen the latest version before saving these edits.' } }; } });
  await assert.rejects(race.run(DRAFT_TOOL, { projectId: P1, markdown: '# T', matterDocumentId: D1, expectedVersionId: V2 }), /^Error: A newer version exists: a colleague saved one in the meantime/);
  assert.ok(raced);
  assert.equal(race.supabase.calls.remove.length, 1);
  assert.equal(actions(race).at(-1).outcome, 'failed');
});
