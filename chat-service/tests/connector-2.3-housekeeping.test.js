// Piece 2.3 of the connector: the six housekeeping writes in
// connector/tools/housekeeping.js (set_project_instructions, label_version,
// rename_document, set_document_status, create_document_record,
// reindex_document). Against a stubbed database and the real write
// foundation (connector/projectWrites.js: checkCaps counting
// connector_actions, recordAction's field check): each tool checks the caps
// first, finds its row, makes exactly one statement as the site's page
// does, records one connector_actions row with ids and never text, and
// answers one or two sentences with the Hub link; a refusal before the
// write is recorded as refused, a database error as failed; a read-only or
// ended sign-in and the 31st write in an hour are refused before anything
// is touched. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES } from '../connector/tools.js';
import { WRITE } from '../connector/app.js';
import { DEFAULT_SCOPE, READ_ONLY_REFUSAL, READ_SCOPE } from '../connector/oauth.js';
import { HOURLY_CAP, SIGN_IN_ENDED_SENTENCE, createProjectWrites } from '../connector/projectWrites.js';
import housekeeping, { DOCUMENT_STATUSES, MAX_INSTRUCTIONS_CHARS, MAX_LABEL_CHARS, MAX_TITLE_CHARS, NEW_RECORD_STATUS, UNRECORDED_LINE, statusValue } from '../connector/tools/housekeeping.js';

const USER = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccc02';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const V2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const T1 = '77777777-7777-4777-8777-777777777777';
const NOBODY = '99999999-9999-4999-8999-999999999999';
const HUB = 'https://hub.test';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLOCK = Date.parse('2026-10-20T09:00:00Z');
const NAMES = ['set_project_instructions', 'label_version', 'rename_document', 'set_document_status', 'create_document_record', 'reindex_document'];

// ---------------------------------------------------------------------------
// A Supabase client over plain arrays. Reads: select/eq/gte/order/limit/
// maybeSingle filter the table's rows (nested selects are already on the
// rows). Writes: update applies its patch to the filtered rows, upsert
// replaces or adds by the onConflict column, insert appends; each is
// recorded in `calls` for the assertions. A table in `errors` refuses its
// write with that error. rpc answers from a script and is recorded too.

function fakeSupabase({ tables = {}, errors = {}, rpc = async () => ({ data: null, error: null }) } = {}) {
  const calls = { update: [], upsert: [], insert: [], rpc: [], reads: [] };
  const chain = (table) => {
    const all = (tables[table] ??= []);
    let rows = [...all];
    let single = false;
    let op = null;
    const q = {
      select() { return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      in(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      gte(col, val) { rows = rows.filter((r) => r[col] >= val); return q; },
      order(col, { ascending = true } = {}) { rows.sort((a, b) => ((a[col] ?? 0) > (b[col] ?? 0) ? 1 : (a[col] ?? 0) < (b[col] ?? 0) ? -1 : 0) * (ascending ? 1 : -1)); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      maybeSingle() { single = true; return q; },
      update(patch) { op = { kind: 'update', patch }; return q; },
      upsert(row, opts) { op = { kind: 'upsert', row, opts }; return q; },
      insert(row) { op = { kind: 'insert', row }; return q; },
      then(ok, bad) {
        let out;
        if (!op) { calls.reads.push(table); const copies = rows.map((r) => ({ ...r })); out = { data: single ? copies[0] ?? null : copies, error: null }; }
        else if (errors[table]) out = { data: null, error: errors[table] };
        else {
          if (op.kind === 'update') { calls.update.push({ table, patch: op.patch, ids: rows.map((r) => r.id) }); for (const r of rows) Object.assign(r, op.patch); }
          if (op.kind === 'upsert') {
            calls.upsert.push({ table, row: op.row, opts: op.opts });
            const key = op.opts?.onConflict ?? 'id';
            const hit = all.find((r) => r[key] === op.row[key]);
            if (hit) Object.assign(hit, op.row); else all.push({ ...op.row });
          }
          if (op.kind === 'insert') { calls.insert.push({ table, row: op.row }); all.push({ ...op.row }); }
          out = { data: null, error: null };
        }
        return Promise.resolve(out).then(ok, bad);
      },
    };
    return q;
  };
  return { calls, tables, from: chain, rpc: async (name, args) => { calls.rpc.push({ name, args }); return rpc(name, args); } };
}

const fixtures = () => ({
  matters: [{ id: P1, name: 'M6 Motorway', status: 'active', client: { name: 'NHA' } }, { id: P2, name: 'KPT Corridor', status: 'active' }],
  matter_context: [{ id: 'ctx1', matter_id: P2, content: 'The client wants a 30-year term.', updated_by: NOBODY, updated_at: '2026-10-05T08:00:00Z' }],
  document_types: [{ id: T1, name: 'Concession Agreement' }],
  matter_documents: [
    { id: D1, title: 'Draft CA', status: 'drafting', matter_id: P1, document_type_id: T1, document_type: { name: 'Concession Agreement' }, matter: { id: P1, name: 'M6 Motorway' }, versions: [{ id: V1, version_number: 1 }, { id: V2, version_number: 2 }] },
    { id: D2, title: 'Term Sheet', status: 'not_started', matter_id: P1, document_type_id: null, document_type: null, matter: { id: P1, name: 'M6 Motorway' }, versions: [] },
  ],
  document_versions: [
    { id: V1, version_number: 1, file_name: 'CA-v1.docx', label: null, indexing_status: 'indexed', indexing_error: null, matter_document: { id: D1, title: 'Draft CA', matter_id: P1, document_type: { name: 'Concession Agreement' }, matter: { id: P1, name: 'M6 Motorway' } } },
    { id: V2, version_number: 2, file_name: 'CA-v2.docx', label: 'Client mark-up', indexing_status: 'failed', indexing_error: 'No text layer', matter_document: { id: D1, title: 'Draft CA', matter_id: P1, document_type: { name: 'Concession Agreement' }, matter: { id: P1, name: 'M6 Motorway' } } },
  ],
  connector_actions: [],
});

/** The module through the registry, with the real write foundation over the stub database. */
function setup({ tables = fixtures(), errors, rpc, recheck } = {}) {
  const supabase = fakeSupabase({ tables, errors, rpc });
  const clock = { ms: CLOCK };
  const writes = createProjectWrites({ supabase, hubUrl: HUB, now: () => new Date(clock.ms), log: () => {} });
  const lines = [];
  const list = createHubTools({ supabase, voyageKey: 'v', library: { searchLaw: async () => [], readActSection: async () => { throw new Error('no'); }, searchPrecedentsTool: async () => [], searchProject: async () => [] }, readFile: async () => ({ blocks: [] }), log: (l) => lines.push(l), hubUrl: HUB, modules: [housekeeping], writes, now: () => clock.ms });
  const ctx = { userId: USER, clientId: 'akh_c_test', scope: DEFAULT_SCOPE, tokenId: 't1', canWrite: true, recheck: recheck ?? (async () => ({ userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' })) };
  const run = (name, input, c = ctx) => list.find((t) => t.name === name).run(input, c);
  const actions = () => supabase.tables.connector_actions;
  return { supabase, list, run, ctx, clock, lines, actions, writes };
}

/** The one record a write leaves: its ids and outcome, and none of the text written. */
function expectRecord(row, { tool, projectId = null, documentId = null, versionId = null, label = null, outcome }) {
  assert.equal(row.user_id, USER);
  assert.equal(row.client_id, 'akh_c_test');
  assert.equal(row.tool, tool);
  assert.equal(row.project_id, projectId);
  assert.equal(row.document_id, documentId);
  assert.equal(row.version_id, versionId);
  assert.equal(row.label, label);
  assert.equal(row.outcome, outcome);
  assert.equal(row.created_at, new Date(CLOCK).toISOString());
  assert.deepEqual(Object.keys(row).sort(), ['client_id', 'created_at', 'document_id', 'id', 'label', 'outcome', 'project_id', 'tool', 'user_id', 'version_id'].sort(), 'only the named fields');
}

// ---------------------------------------------------------------------------
// The module's shape

test('the module adds six write tools after the built-in eight, every one WRITE-annotated, none a delete', async () => {
  const { list } = setup();
  assert.deepEqual(list.map((t) => t.name), [...BUILT_IN_TOOL_NAMES, ...NAMES]);
  for (const t of list.slice(BUILT_IN_TOOL_NAMES.length)) {
    assert.ok(t.title, `${t.name} has a title`);
    assert.ok(t.description.length > 150, `${t.name} tells a lawyer's Claude what it does, when, and what it changes`);
    assert.match(t.description, /asked before/, `${t.name} says the lawyer is asked first`);
    assert.equal(t.write, true, `${t.name} is a write tool`);
    assert.equal(t.annotations.readOnlyHint, false);
    assert.equal(t.annotations.destructiveHint, true, `${t.name} prompts in claude.ai (owner decision 5)`);
    assert.doesNotMatch(t.name, /delete|remove|drop/, 'no delete tool anywhere');
  }
  for (const name of NAMES.filter((n) => n !== 'reindex_document')) assert.deepEqual(list.find((t) => t.name === name).annotations, WRITE);
  assert.deepEqual(list.find((t) => t.name === 'reindex_document').annotations, { ...WRITE, idempotentHint: true }, 'reading again twice is harmless');
  const byName = Object.fromEntries(list.map((t) => [t.name, t]));
  assert.ok(byName.set_project_instructions.inputSchema.projectId && byName.set_project_instructions.inputSchema.content);
  assert.ok(byName.label_version.inputSchema.versionId && byName.label_version.inputSchema.label);
  assert.ok(byName.rename_document.inputSchema.documentId && byName.rename_document.inputSchema.versionId && byName.rename_document.inputSchema.title);
  assert.ok(byName.rename_document.inputSchema.documentId.isOptional() && byName.rename_document.inputSchema.versionId.isOptional());
  assert.ok(!('documentTypeId' in byName.rename_document.inputSchema), 'the type is never changed from claude.ai');
  // The status is a string, not an enum: the description names the statuses with spaces, and the SDK's schema check must not refuse "internal review" before statusValue can read it.
  assert.ok(byName.set_document_status.inputSchema.status.safeParse('internal review').success);
  assert.match(byName.set_document_status.inputSchema.status.description, /not started, drafting, internal review, with counterparty, negotiation, finalized, executed/);
  assert.match(byName.set_document_status.description, /not started → drafting → internal review → with counterparty → negotiation → finalized → executed/);
  assert.deepEqual(DOCUMENT_STATUSES, ['not_started', 'drafting', 'internal_review', 'with_counterparty', 'negotiation', 'finalized', 'executed'], 'the document_status enum of 20260820061242');
  assert.ok(byName.create_document_record.inputSchema.projectId && byName.create_document_record.inputSchema.title && byName.create_document_record.inputSchema.documentTypeId.isOptional());
  assert.ok(byName.reindex_document.inputSchema.versionId);
  assert.equal(statusValue('Internal review'), 'internal_review');
  assert.equal(statusValue('with-counterparty'), 'with_counterparty');
  assert.equal(statusValue('signed'), null);
  // The real directory loads it too, under its file name.
  const modules = await loadToolModules();
  assert.ok(modules.some((m) => m.file === 'housekeeping.js'));
});

// ---------------------------------------------------------------------------
// The gate every tool passes first

test('a read-only or ended sign-in, and the 31st write in an hour, are refused before anything is touched', async () => {
  const t = setup();
  const quiet = () => { assert.equal(t.supabase.calls.update.length + t.supabase.calls.upsert.length + t.supabase.calls.insert.length + t.supabase.calls.rpc.length, 0, 'nothing written'); };
  // The registry's floor: a read-only ctx never reaches the tool.
  await assert.rejects(t.run('label_version', { versionId: V1, label: 'x' }, { ...t.ctx, scope: READ_SCOPE, canWrite: false }), new RegExp(READ_ONLY_REFUSAL.slice(0, 30)));
  // checkCaps: the fresh check finds the token gone.
  await assert.rejects(t.run('label_version', { versionId: V1, label: 'x' }, { ...t.ctx, recheck: async () => null }), new RegExp(SIGN_IN_ENDED_SENTENCE.slice(0, 30)));
  // checkCaps: the fresh check says the sign-in was narrowed to hub:read.
  await assert.rejects(t.run('label_version', { versionId: V1, label: 'x' }, { ...t.ctx, recheck: async () => ({ userId: USER, scope: READ_SCOPE }) }), new RegExp(READ_ONLY_REFUSAL.slice(0, 30)));
  quiet();
  assert.equal(t.actions().length, 0, 'a refusal at the gate is not a write and leaves no row');
  // 30 refused rows in the hour (guessed ids, the status it already had) wrote nothing: not counted.
  for (let i = 0; i < HOURLY_CAP; i += 1) t.actions().push({ id: `x${i}`, user_id: USER, tool: 'rename_document', outcome: 'refused', created_at: new Date(CLOCK - (i + 1) * 60_000).toISOString() });
  assert.match(await t.run('label_version', { versionId: V1, label: 'Still allowed' }), /is labelled "Still allowed"/);
  assert.equal(t.actions().at(-1).outcome, 'done');
  // 30 saved or done rows in the hour, whichever tool wrote them: the next is refused.
  t.actions().length = 0;
  for (let i = 0; i < HOURLY_CAP; i += 1) t.actions().push({ id: `r${i}`, user_id: USER, tool: i % 2 ? 'save_note_to_project' : 'label_version', outcome: i % 2 ? 'saved' : 'done', created_at: new Date(CLOCK - (i + 1) * 60_000).toISOString() });
  t.supabase.calls.update.length = 0;
  t.supabase.calls.insert.length = 0;
  await assert.rejects(t.run('set_project_instructions', { projectId: P1, content: 'x' }), /You have saved 30 times from claude.ai in the last hour/);
  quiet();
  assert.equal(t.actions().length, HOURLY_CAP);
});

test('when the change landed but its record could not be written, the reply still reports the change, with one line saying so, and nothing invites a retry', async () => {
  const t = setup({ errors: { connector_actions: { message: 'remaining connection slots are reserved' } } });
  const out = await t.run('label_version', { versionId: V2, label: 'Signed copy' });
  assert.equal(out, `Draft CA v2 (CA-v2.docx) on M6 Motorway is labelled "Signed copy" (it was "Client mark-up").\nOpen in Hub: ${HUB}/ai/d/${V2}\nThe change was made but could not be recorded; tell the Hub's owner.`);
  assert.deepEqual(t.supabase.calls.update, [{ table: 'document_versions', patch: { label: 'Signed copy' }, ids: [V2] }], 'the change landed');
  assert.equal(t.actions().length, 0, 'no row could be written');
  assert.ok(t.lines.some((l) => /^label_version: the change was made but the record could not be written: The write could not be recorded: remaining connection slots are reserved$/.test(l)), t.lines.join('\n'));
  // create_document_record the same: one record, not two on a retry.
  const made = await t.run('create_document_record', { projectId: P1, title: 'SHA' });
  assert.match(made, /^Created "SHA" on M6 Motorway: status drafting, no versions yet\. documentId: [0-9a-f-]{36}\..*\nOpen in Hub: .*\nThe change was made but could not be recorded; tell the Hub's owner\.$/s);
  assert.equal(t.supabase.calls.insert.filter((c) => c.table === 'matter_documents').length, 1);
  assert.equal(UNRECORDED_LINE, "The change was made but could not be recorded; tell the Hub's owner.");
  // A refusal before the write is still a refusal (its own record failing is swallowed as before).
  await assert.rejects(t.run('rename_document', { documentId: D1, title: 'Draft CA' }), /The document is already called "Draft CA"\./);
});

// ---------------------------------------------------------------------------
// set_project_instructions

test('set_project_instructions upserts the project\'s context as the lawyer and says what it replaced', async () => {
  const t = setup();
  const content = 'The client is the Sindh PPP Unit.\r\nNotices go to the Director (Legal).\n';
  const out = await t.run('set_project_instructions', { projectId: P1, content });
  assert.equal(out, `The standing instructions for M6 Motorway are set (69 characters; the project had none before). Every Hub chat and claude.ai overview of the project now sees them.\nOpen in Hub: ${HUB}/ai/p/${P1}`);
  assert.equal(t.supabase.calls.upsert.length, 1);
  const { row, opts } = t.supabase.calls.upsert[0];
  assert.deepEqual(opts, { onConflict: 'matter_id' }, 'the site\'s own upsert (useMatterContext.ts)');
  assert.deepEqual(row, { matter_id: P1, content: 'The client is the Sindh PPP Unit.\nNotices go to the Director (Legal).', updated_by: USER, updated_at: new Date(CLOCK).toISOString() });
  assert.equal(t.supabase.tables.matter_context.length, 2);
  assert.equal(t.actions().length, 1);
  expectRecord(t.actions()[0], { tool: 'set_project_instructions', projectId: P1, outcome: 'done' });
  assert.ok(!JSON.stringify(t.actions()[0]).includes('Sindh'), 'never the text');
  // Replacing: the reply says how long the old ones were and when they were written.
  const again = await t.run('set_project_instructions', { projectId: P2, content: 'Use the 2024 NHA model agreement.' });
  assert.match(again, /^The standing instructions for KPT Corridor are set \(33 characters; they replace the 32-character instructions written 5 Oct 2026\)\./);
  assert.equal(t.supabase.tables.matter_context.find((r) => r.matter_id === P2).content, 'Use the 2024 NHA model agreement.');
  assert.equal(t.supabase.tables.matter_context.find((r) => r.matter_id === P2).updated_by, USER);
  assert.equal(t.supabase.tables.matter_context.length, 2, 'one row per project');
  assert.match(t.lines.at(-1), /^set_project_instructions for 11111111-1111-4111-8111-111111111111: \d+ chars in \d+ ms$/);
});

test('set_project_instructions refuses empty or too-long text and an unknown project, records the refusal, writes nothing', async () => {
  const t = setup();
  await assert.rejects(t.run('set_project_instructions', { projectId: P1, content: '  \n ' }), /There is nothing to write: give the instructions' complete text \(this tool cannot clear them\)\./);
  await assert.rejects(t.run('set_project_instructions', { projectId: P1, content: 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 1) }), /The instructions are 20,001 characters; the Hub keeps at most 20,000\. Shorten them\./);
  await assert.rejects(t.run('set_project_instructions', { projectId: NOBODY, content: 'x' }), /There is no project with that id/);
  await assert.rejects(t.run('set_project_instructions', { projectId: 'nope', content: 'x' }), /projectId must be a project id/);
  assert.equal(t.supabase.calls.upsert.length, 0);
  assert.equal(t.actions().length, 4);
  for (const row of t.actions()) expectRecord(row, { tool: 'set_project_instructions', outcome: 'refused' });
});

// ---------------------------------------------------------------------------
// label_version

test('label_version updates the one version\'s label and says what it was', async () => {
  const t = setup();
  const out = await t.run('label_version', { versionId: V2, label: '  Signed  copy ' });
  assert.equal(out, `Draft CA v2 (CA-v2.docx) on M6 Motorway is labelled "Signed copy" (it was "Client mark-up").\nOpen in Hub: ${HUB}/ai/d/${V2}`);
  assert.deepEqual(t.supabase.calls.update, [{ table: 'document_versions', patch: { label: 'Signed copy' }, ids: [V2] }]);
  assert.equal(t.supabase.tables.document_versions.find((v) => v.id === V1).label, null, 'the other version is untouched');
  expectRecord(t.actions()[0], { tool: 'label_version', projectId: P1, documentId: D1, versionId: V2, label: 'Signed copy', outcome: 'done' });
  const first = await t.run('label_version', { versionId: V1, label: 'Sent to SECP' });
  assert.equal(first, `Draft CA v1 (CA-v1.docx) on M6 Motorway is labelled "Sent to SECP".\nOpen in Hub: ${HUB}/ai/d/${V1}`);
});

test('label_version refuses a blank or long label and an unknown version', async () => {
  const t = setup();
  await assert.rejects(t.run('label_version', { versionId: V1, label: ' ' }), /A label is needed \(this tool cannot clear one; do that on the Hub\)\./);
  await assert.rejects(t.run('label_version', { versionId: V1, label: 'x'.repeat(MAX_LABEL_CHARS + 1) }), /A label is at most 120 characters; this one is 121\./);
  await assert.rejects(t.run('label_version', { versionId: NOBODY, label: 'x' }), /There is no project document version with that id/);
  await assert.rejects(t.run('label_version', { label: 'x' }), /versionId must be a document version id/);
  assert.equal(t.supabase.calls.update.length, 0);
  assert.equal(t.actions().length, 4);
  for (const row of t.actions()) assert.equal(row.outcome, 'refused');
});

// ---------------------------------------------------------------------------
// rename_document

test('rename_document changes the title only, by the document\'s id or by one of its versions', async () => {
  const t = setup();
  const out = await t.run('rename_document', { documentId: D1, title: ' Concession Agreement —  Hyderabad bypass ' });
  assert.equal(out, `"Draft CA" on M6 Motorway is now called "Concession Agreement — Hyderabad bypass"; its type (Concession Agreement), status and versions are unchanged.\nOpen in Hub: ${HUB}/ai/d/${V2}`);
  assert.deepEqual(t.supabase.calls.update, [{ table: 'matter_documents', patch: { title: 'Concession Agreement — Hyderabad bypass' }, ids: [D1] }], 'title only, never document_type_id');
  expectRecord(t.actions()[0], { tool: 'rename_document', projectId: P1, documentId: D1, versionId: V2, outcome: 'done' });
  assert.ok(!JSON.stringify(t.actions()[0]).includes('Hyderabad'), 'the record carries ids, not the title');
  // By a version id; a document without versions links to its project.
  const byVersion = await t.run('rename_document', { versionId: V1, title: 'CA' });
  assert.match(byVersion, /^"Concession Agreement — Hyderabad bypass" on M6 Motorway is now called "CA"/);
  const noVersions = await t.run('rename_document', { documentId: D2, title: 'Term Sheet (signed)' });
  assert.equal(noVersions, `"Term Sheet" on M6 Motorway is now called "Term Sheet (signed)"; its type, status and versions are unchanged.\nOpen in Hub: ${HUB}/ai/p/${P1}`);
});

test('rename_document refuses no id, an unknown document, the same title, a blank or long title', async () => {
  const t = setup();
  await assert.rejects(t.run('rename_document', { title: 'x' }), /Give the document's id \(documentId, from find_document_by_title\) or the id of one of its versions/);
  await assert.rejects(t.run('rename_document', { documentId: NOBODY, title: 'x' }), /There is no project document with that id/);
  await assert.rejects(t.run('rename_document', { versionId: NOBODY, title: 'x' }), /There is no project document version with that id/);
  await assert.rejects(t.run('rename_document', { documentId: D1, title: 'Draft CA' }), /The document is already called "Draft CA"\./);
  await assert.rejects(t.run('rename_document', { documentId: D1, title: '' }), /A new title is needed\./);
  await assert.rejects(t.run('rename_document', { documentId: D1, title: 'x'.repeat(MAX_TITLE_CHARS + 1) }), /A title is at most 200 characters; this one is 201\./);
  assert.equal(t.supabase.calls.update.length, 0);
  assert.equal(t.actions().length, 6);
  for (const row of t.actions()) assert.equal(row.outcome, 'refused');
});

// ---------------------------------------------------------------------------
// set_document_status

test('set_document_status moves the whole document along the status line and says where it was', async () => {
  const t = setup();
  const out = await t.run('set_document_status', { documentId: D1, status: 'with_counterparty' });
  assert.equal(out, `Draft CA (Concession Agreement) on M6 Motorway is now "with counterparty" (it was "drafting").\nOpen in Hub: ${HUB}/ai/d/${V2}`);
  assert.deepEqual(t.supabase.calls.update, [{ table: 'matter_documents', patch: { status: 'with_counterparty' }, ids: [D1] }]);
  expectRecord(t.actions()[0], { tool: 'set_document_status', projectId: P1, documentId: D1, versionId: V2, outcome: 'done' });
  const byVersion = await t.run('set_document_status', { versionId: V1, status: 'executed' });
  assert.match(byVersion, /^Draft CA \(Concession Agreement\) on M6 Motorway is now "executed" \(it was "with counterparty"\)\./);
  const fresh = await t.run('set_document_status', { documentId: D2, status: 'drafting' });
  assert.equal(fresh, `Term Sheet on M6 Motorway is now "drafting" (it was "not started").\nOpen in Hub: ${HUB}/ai/p/${P1}`);
  // The status in the description's own words (spaces, any case) is read as the enum value.
  const spaced = await t.run('set_document_status', { documentId: D2, status: 'Internal review' });
  assert.match(spaced, /^Term Sheet on M6 Motorway is now "internal review" \(it was "drafting"\)\./);
  assert.equal(t.supabase.calls.update.at(-1).patch.status, 'internal_review');
});

test('set_document_status refuses a status the enum lacks, the status it already has, and an unknown document', async () => {
  const t = setup();
  // The schema lets "signed" through (a plain string); the tool refuses it with the list.
  await assert.rejects(t.run('set_document_status', { documentId: D1, status: 'signed' }), /The status must be one of not_started, drafting, internal_review, with_counterparty, negotiation, finalized, executed\./);
  await assert.rejects(t.run('set_document_status', { documentId: D1, status: 'drafting' }), /Draft CA \(Concession Agreement\) on M6 Motorway is already "drafting"\./);
  await assert.rejects(t.run('set_document_status', { documentId: NOBODY, status: 'drafting' }), /There is no project document with that id/);
  assert.equal(t.supabase.calls.update.length, 0);
  assert.equal(t.actions().length, 3);
  for (const row of t.actions()) assert.equal(row.outcome, 'refused');
});

// ---------------------------------------------------------------------------
// create_document_record

test('create_document_record inserts an empty record with the lawyer as creator, typed when a type is given', async () => {
  const t = setup();
  const out = await t.run('create_document_record', { projectId: P1, title: ' Shareholders  Agreement ' });
  const row = t.supabase.calls.insert.find((c) => c.table === 'matter_documents').row;
  assert.match(row.id, UUID_RE);
  assert.deepEqual(row, { id: row.id, matter_id: P1, title: 'Shareholders Agreement', document_type_id: null, status: NEW_RECORD_STATUS, created_by: USER });
  assert.equal(NEW_RECORD_STATUS, 'drafting');
  assert.equal(out, `Created "Shareholders Agreement" on M6 Motorway: status drafting, no versions yet. documentId: ${row.id}. Save its first version with a saving tool (save_note_to_project or save_draft_to_project, with matterDocumentId ${row.id}) or upload one on the Hub.\nOpen in Hub: ${HUB}/ai/p/${P1}`);
  expectRecord(t.actions()[0], { tool: 'create_document_record', projectId: P1, outcome: 'done' });
  assert.ok(!JSON.stringify(t.actions()[0]).includes('Shareholders'));
  const typed = await t.run('create_document_record', { projectId: P2, title: 'CA', documentTypeId: T1 });
  const typedRow = t.supabase.calls.insert.filter((c) => c.table === 'matter_documents')[1].row;
  assert.equal(typedRow.document_type_id, T1);
  assert.match(typed, /^Created "CA" \(Concession Agreement\) on KPT Corridor: status drafting, no versions yet\. documentId: /);
});

test('create_document_record refuses a blank title, an unknown project and an unknown type', async () => {
  const t = setup();
  await assert.rejects(t.run('create_document_record', { projectId: P1, title: '' }), /A title for the document is needed\./);
  await assert.rejects(t.run('create_document_record', { projectId: NOBODY, title: 'x' }), /There is no project with that id/);
  await assert.rejects(t.run('create_document_record', { projectId: P1, title: 'x', documentTypeId: 'nope' }), /documentTypeId must be a document type's id \(a UUID\)\. list_document_types gives them\./);
  await assert.rejects(t.run('create_document_record', { projectId: P1, title: 'x', documentTypeId: NOBODY }), /There is no document type with that id\. list_document_types gives them\./);
  assert.equal(t.supabase.calls.insert.filter((c) => c.table === 'matter_documents').length, 0);
  assert.equal(t.actions().length, 4);
  for (const row of t.actions()) assert.equal(row.outcome, 'refused');
});

// ---------------------------------------------------------------------------
// reindex_document

test('reindex_document calls enqueue_index_job for the version and reports queued, already running, or unsupported', async () => {
  const states = { [V1]: { jobId: 'j1', state: 'queued' }, [V2]: { jobId: 'j2', state: 'queued' } };
  const t = setup({ rpc: async (name, args) => { assert.equal(name, 'enqueue_index_job'); return { data: states[args.p_version_id], error: null }; } });
  const failed = await t.run('reindex_document', { versionId: V2 });
  assert.equal(failed, `The Hub will read Draft CA v2 (CA-v2.docx) on M6 Motorway again now. It could not be read last time (No text layer). Call get_document_summary on it in about a minute (longer for a scanned PDF); the project page shows its progress.\nOpen in Hub: ${HUB}/ai/d/${V2}`);
  assert.deepEqual(t.supabase.calls.rpc, [{ name: 'enqueue_index_job', args: { p_version_id: V2 } }]);
  expectRecord(t.actions()[0], { tool: 'reindex_document', projectId: P1, documentId: D1, versionId: V2, outcome: 'done' });
  const fine = await t.run('reindex_document', { versionId: V1 });
  assert.equal(fine, `The Hub will read Draft CA v1 (CA-v1.docx) on M6 Motorway again now. Call get_document_summary on it in about a minute (longer for a scanned PDF); the project page shows its progress.\nOpen in Hub: ${HUB}/ai/d/${V1}`);
  // A second ask while it runs: the function leaves the job alone, and so does the reply.
  states[V1] = { jobId: 'j1', state: 'running' };
  const running = await t.run('reindex_document', { versionId: V1 });
  assert.equal(running, `Draft CA v1 (CA-v1.docx) on M6 Motorway is being read by the Hub right now; nothing more was queued. Call get_document_summary in a minute or two.\nOpen in Hub: ${HUB}/ai/d/${V1}`);
  assert.equal(t.actions().at(-1).outcome, 'done');
  // A kind of file the worker does not read: refused, recorded as such.
  states[V1] = { state: 'unsupported' };
  await assert.rejects(t.run('reindex_document', { versionId: V1 }), /^Error: The Hub cannot read files of this kind \(Draft CA v1 \(CA-v1\.docx\) on M6 Motorway\): it reads Word, PDF, text, Markdown and the common office formats\. Nothing was queued\.$/);
  assert.equal(t.actions().at(-1).outcome, 'refused');
  assert.equal(t.actions().at(-1).version_id, V1);
  await assert.rejects(t.run('reindex_document', { versionId: NOBODY }), /There is no project document version with that id/);
  assert.equal(t.supabase.calls.rpc.length, 4, 'no call for an unknown version');
});

// ---------------------------------------------------------------------------
// When the database refuses the write

test('a database error on the write is one plain sentence and a "failed" row; the function\'s reasons are translated', async () => {
  const t = setup({ errors: { matter_documents: { message: 'insert or update on table "matter_documents" violates foreign key constraint "matter_documents_document_type_id_fkey"' }, matter_context: { message: 'permission denied for table matter_context' } } });
  await assert.rejects(t.run('rename_document', { documentId: D1, title: 'New' }), /^Error: The Hub refused the rename the document: something it refers to \(the project, the type or your account\) is not on the Hub\.$/);
  expectRecord(t.actions()[0], { tool: 'rename_document', projectId: P1, documentId: D1, versionId: V2, outcome: 'failed' });
  await assert.rejects(t.run('set_project_instructions', { projectId: P1, content: 'x' }), /^Error: The Hub could not write the instructions \(permission denied for table matter_context\)\.$/);
  expectRecord(t.actions()[1], { tool: 'set_project_instructions', projectId: P1, outcome: 'failed' });
  const gone = setup({ rpc: async () => ({ data: null, error: { message: 'Document version is unavailable' } }) });
  await assert.rejects(gone.run('reindex_document', { versionId: V1 }), /^Error: That version's file is not on the Hub any more, so it cannot be read again\.$/);
  assert.equal(gone.actions()[0].outcome, 'failed');
  const forbidden = setup({ rpc: async () => ({ data: null, error: { message: 'Forbidden' } }) });
  await assert.rejects(forbidden.run('reindex_document', { versionId: V1 }), /^Error: Only approved members of the firm can change a project on the Hub\.$/);
});
