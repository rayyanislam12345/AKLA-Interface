// Slice 2.0, the write foundation: the two scopes, write tools hidden from
// a read-only sign-in and refused with one sentence if called anyway, the
// annotations claude.ai sees, the fresh re-check of the token on a write,
// the caps counted from connector_actions, the record of every write, and
// saveVersion against a stub Supabase (the path shape, the upload, the RPC's
// arguments, the rollback, the lost-response retry). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, READ_ONLY, WRITE } from '../connector/app.js';
import { createMemoryStore } from '../connector/store.js';
import { createHubTools, BUILT_IN_TOOL_NAMES } from '../connector/tools.js';
import { DEFAULT_SCOPE, READ_ONLY_REFUSAL, READ_SCOPE, WRITE_SCOPE, authenticateBearer, exchangeToken, hasScope, issueCode, metadata, registerClient, revokeToken, scopeOf } from '../connector/oauth.js';
import { BUCKET, DAILY_CAP, HOURLY_CAP, IN_FLIGHT_MS, SIGN_IN_ENDED_SENTENCE, createProjectWrites, sanitizeStorageFilename, splitFileName, storageStem, versionLabel } from '../connector/projectWrites.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const V2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NEW_V = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLOCK = Date.parse('2026-10-20T09:00:00Z');

// ---------------------------------------------------------------------------
// A Supabase stub for the write path: tables with the filters the module
// uses, a storage bucket that remembers uploads and removals, and an rpc
// that answers from a script. Every call is recorded for the assertions.

function fakeSupabase({ tables = {}, rpc = async () => ({ data: null, error: null }), errors = {} } = {}) {
  const calls = { upload: [], remove: [], rpc: [], insert: [] };
  const objects = new Set();
  const chain = (table) => {
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
        upload: async (path, body, opts) => { calls.upload.push({ bucket, path, bytes: body.length, opts }); objects.add(path); return { data: { path }, error: null }; },
        remove: async (paths) => { calls.remove.push({ bucket, paths }); for (const p of paths) objects.delete(p); return { data: paths, error: null }; },
        download: async () => ({ data: null, error: { message: 'none' } }),
      }),
    },
  };
}

// The database's save, as the migration writes it: refuses when the
// staged object is missing, when the expected version is stale, when the
// document is not on the project; otherwise the next number.
function scriptedSave({ tables }) {
  return async (name, args, { objects }) => {
    assert.equal(name, 'save_document_version_as');
    if (!objects.has(args.p_storage_path)) return { data: null, error: { message: 'The uploaded file is unavailable' } };
    const versions = (tables.document_versions ?? []).filter((v) => v.matter_document_id === args.p_document_id).sort((a, b) => b.version_number - a.version_number);
    if (!args.p_create_new) {
      const doc = (tables.matter_documents ?? []).find((d) => d.id === args.p_document_id && d.matter_id === args.p_matter_id);
      if (!doc) return { data: null, error: { message: 'Document does not belong to this project and type' } };
      if ((versions[0]?.id ?? null) !== args.p_expected_version_id) return { data: null, error: { message: 'A newer document version exists. Reopen the latest version before saving these edits.' } };
    }
    const number = (versions[0]?.version_number ?? 0) + 1;
    const row = { id: NEW_V, matter_document_id: args.p_document_id, version_number: number, storage_path: args.p_storage_path, file_name: `${args.p_file_stem}-v${number}.${args.p_extension}`, is_ai_generated: args.p_is_ai_generated, uploaded_by: args.p_user_id, label: args.p_label };
    (tables.document_versions ??= []).push(row);
    return { data: { matterDocumentId: args.p_document_id, versionId: row.id, versionNumber: number, fileName: row.file_name }, error: null };
  };
}

const fixtures = () => ({
  matters: [{ id: P1, name: 'M6 Motorway', status: 'active' }, { id: P2, name: 'KPT Corridor', status: 'active' }],
  matter_documents: [{ id: D1, title: 'Concession Agreement', matter_id: P1, document_type_id: null }],
  document_versions: [
    { id: V1, matter_document_id: D1, version_number: 1, storage_path: `${P1}/${D1}/x-CA.docx`, file_name: 'CA-v1.docx' },
    { id: V2, matter_document_id: D1, version_number: 2, storage_path: `${P1}/${D1}/y-CA.docx`, file_name: 'CA-v2.docx' },
  ],
  connector_actions: [],
});

const ctxOf = (extra = {}) => ({ userId: USER, clientId: 'akh_c_test', scope: DEFAULT_SCOPE, tokenId: 't1', canWrite: true, ...extra });

// ---------------------------------------------------------------------------
// Scopes

test('two scopes: asked ones are granted in order, none asked means both, unknown ones are dropped', () => {
  assert.deepEqual(scopeOf('hub:read'), { scope: 'hub:read', ignored: [] });
  assert.deepEqual(scopeOf('hub:write'), { scope: 'hub:write', ignored: [] });
  assert.deepEqual(scopeOf('hub:write hub:read'), { scope: 'hub:read hub:write', ignored: [] });
  assert.deepEqual(scopeOf('offline_access'), { scope: DEFAULT_SCOPE, ignored: ['offline_access'] });
  assert.deepEqual(scopeOf(''), { scope: 'hub:read hub:write', ignored: [] });
  assert.ok(hasScope('hub:read hub:write', WRITE_SCOPE));
  assert.ok(!hasScope('hub:read', WRITE_SCOPE));
  assert.ok(!hasScope('hub:readhub:write', WRITE_SCOPE), 'whole words only');
  assert.ok(!hasScope(undefined, READ_SCOPE));
  assert.deepEqual(metadata('https://hub.test').authorizationServer.scopes_supported, ['hub:read', 'hub:write']);
  assert.deepEqual(READ_ONLY, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(WRITE, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, 'every write tool prompts: destructive always does (owner decision 5)');
});

test('a registered client is told both scopes; a token keeps the scope its code carried through refreshes', async () => {
  const store = createMemoryStore();
  const reg = await registerClient(store, { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  assert.equal(reg.scope, 'hub:read hub:write');
  const client = await store.getClient(reg.client_id);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // A code from before hub:write existed (or a sign-in that asked for hub:read only).
  const code = await issueCode(store, { client, userId: USER, redirectUri: reg.redirect_uris[0], codeChallenge: challenge, scope: READ_SCOPE });
  const tokens = await exchangeToken(store, { grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: reg.redirect_uris[0], code_verifier: verifier });
  assert.equal(tokens.scope, 'hub:read');
  const refreshed = await exchangeToken(store, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id });
  assert.equal(refreshed.scope, 'hub:read', 'a refresh never widens the scope: the lawyer reconnects for that');
  const auth = await authenticateBearer(store, refreshed.access_token);
  assert.equal(auth.scope, 'hub:read');
  // And a row with no scope at all (older than the column) is read-only.
  for (const t of store.tokens.values()) t.scope = null;
  assert.equal((await authenticateBearer(store, refreshed.access_token)).scope, READ_SCOPE);
});

// ---------------------------------------------------------------------------
// Registration by scope, through the SDK client

const WRITE_MODULE = (writes) => (deps) => [{
  name: 'save_test_note',
  title: 'Save a test note',
  description: 'A stand-in for a slice 2 write tool: checks the caps, saves through deps.writes, records the action, so the registry and the server can be tested.',
  inputSchema: { projectId: z.string(), text: z.string() },
  write: true,
  annotations: WRITE,
  async run(input, ctx) {
    const w = deps.writes;
    assert.equal(w, writes, 'the module gets the writes it was built with');
    const caps = await w.checkCaps(ctx);
    try {
      const saved = await w.saveVersion({ ctx, projectId: input.projectId, title: 'Test note', bytes: Buffer.from(input.text, 'utf8'), fileName: 'Test note.md' });
      await w.recordAction(ctx, { tool: 'save_test_note', projectId: input.projectId, documentId: saved.matterDocumentId, versionId: saved.versionId, label: saved.label, outcome: 'saved' });
      return `saved v${saved.versionNumber} as ${[ctx.userId, ctx.scope, ctx.canWrite, typeof ctx.recheck].join('|')}\n${deps.helpers.open('version', saved.versionId)}`;
    } finally { caps.release(); }
  },
}, {
  name: 'peek_ctx',
  description: 'A read tool beside the write tool, to show what ctx a read tool sees and that it stays read-only.',
  inputSchema: {},
  async run(input, ctx) { return [ctx.userId, ctx.scope, ctx.canWrite, typeof ctx.recheck, ctx.tokenId ? 'tokenId' : 'no-tokenId'].join('|'); },
}];

async function startServer({ scope = DEFAULT_SCOPE, supabase = fakeSupabase({ tables: fixtures(), rpc: scriptedSave({ tables: {} }) }) } = {}) {
  const store = createMemoryStore();
  const clock = { ms: CLOCK };
  const now = () => new Date(clock.ms);
  const writes = createProjectWrites({ supabase, hubUrl: 'https://hub.test', now, log: () => {} });
  const modules = [{ file: 'zz_write.js', tools: WRITE_MODULE(writes) }];
  const tools = createHubTools({ supabase, voyageKey: 'v', library: { searchLaw: async () => [], readActSection: async () => { throw new Error('no'); }, searchPrecedentsTool: async () => [], searchProject: async () => [] }, readFile: async () => ({ blocks: [] }), log: () => {}, hubUrl: 'https://hub.test', modules, writes, now: () => clock.ms });
  const app = createApp({ store, signIn: async () => ({ ok: false, reason: 'bad_password', message: 'no' }), tools, issuer: 'https://hub.test', isMember: async (id) => id === USER, log: () => {}, now });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const reg = await registerClient(store, { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }, { now });
  const client = await store.getClient(reg.client_id);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = await issueCode(store, { client, userId: USER, redirectUri: reg.redirect_uris[0], codeChallenge: challenge, scope }, { now });
  const tokens = await exchangeToken(store, { grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: reg.redirect_uris[0], code_verifier: verifier }, { now });
  return { store, clock, supabase, writes, reg, tokens, url, tools, close: () => new Promise((r) => server.close(r)) };
}

const connect = async (url, token) => {
  const client = new Client({ name: 'test-claude', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};

test('a sign-in with hub:write sees the write tool with its own annotations, read tools stay read-only, and a save goes through the foundation', async () => {
  const t = await startServer();
  try {
    const client = await connect(t.url, t.tokens.access_token);
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    assert.deepEqual(names.slice(0, 8), [...BUILT_IN_TOOL_NAMES]);
    assert.ok(names.includes('save_test_note'));
    const write = tools.find((x) => x.name === 'save_test_note');
    assert.deepEqual(write.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    for (const x of tools) if (x.name !== 'save_test_note') assert.equal(x.annotations?.readOnlyHint, true, `${x.name} stays read-only`);
    const peek = await client.callTool({ name: 'peek_ctx', arguments: {} });
    assert.equal(peek.content[0].text, `${USER}|hub:read hub:write|true|function|tokenId`, 'ctx carries the scope, canWrite and a recheck');

    const saved = await client.callTool({ name: 'save_test_note', arguments: { projectId: P1, text: 'Notes on the term sheet.' } });
    assert.equal(saved.isError, undefined, saved.content?.[0]?.text);
    assert.match(saved.content[0].text, new RegExp(`^saved v1 as ${USER}\\|hub:read hub:write\\|true\\|function\\nOpen in Hub: https://hub\\.test/ai/d/${NEW_V}$`));
    // One upload under the site's path shape, one RPC as the lawyer, one record.
    assert.equal(t.supabase.calls.upload.length, 1);
    assert.match(t.supabase.calls.upload[0].path, new RegExp(`^${P1}/[0-9a-f-]{36}/[0-9a-f-]{36}-Test-note\\.md$`));
    assert.equal(t.supabase.calls.rpc[0].args.p_user_id, USER);
    assert.equal(t.supabase.calls.insert.filter((c) => c.table === 'connector_actions').length, 1);
    const row = t.supabase.tables.connector_actions[0];
    assert.equal(row.user_id, USER);
    assert.equal(row.tool, 'save_test_note');
    assert.equal(row.version_id, NEW_V);
    assert.equal(row.outcome, 'saved');
    assert.ok(!('text' in row) && !('content' in row), 'never the document text');
    // The write re-checked the token afresh: its last use is noted on the row.
    const access = [...t.store.tokens.values()].find((r) => r.kind === 'access');
    assert.equal(access.last_used_at, new Date(CLOCK).toISOString());
    // A failed save is an error result worded as a save, not a lookup.
    const bad = await client.callTool({ name: 'save_test_note', arguments: { projectId: 'nope', text: 'x' } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /^The save failed: projectId must be a project id/);
    await client.close();
  } finally { await t.close(); }
});

test('a read-only sign-in never sees the write tool; calling it anyway gets one sentence; the wrapper refuses too', async () => {
  const t = await startServer({ scope: READ_SCOPE });
  try {
    const client = await connect(t.url, t.tokens.access_token);
    assert.match(client.getInstructions() ?? '', /This sign-in is read-only: nothing here can change, fill or save a document\. If the lawyer asks you to draft, fill, file or save anything/);
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    assert.ok(!names.includes('save_test_note'), 'hidden');
    assert.ok(names.includes('peek_ctx'), 'the read tool beside it is there');
    for (const x of tools) assert.equal(x.annotations?.readOnlyHint, true);
    const peek = await client.callTool({ name: 'peek_ctx', arguments: {} });
    assert.equal(peek.content[0].text, `${USER}|hub:read|false|function|tokenId`);
    const refused = await client.callTool({ name: 'save_test_note', arguments: { projectId: P1, text: 'x' } });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, READ_ONLY_REFUSAL);
    assert.equal(t.supabase.calls.upload.length, 0, 'nothing was written');
    assert.equal(t.supabase.calls.rpc.length, 0);
    // The listing is still clean on the next request (one server per request).
    const again = await (await connect(t.url, t.tokens.access_token)).listTools();
    assert.ok(!again.tools.some((x) => x.name === 'save_test_note'));
    await client.close();
    // The registry's own floor: the tool run with a read-only ctx refuses before doing anything.
    const tool = t.tools.find((x) => x.name === 'save_test_note');
    await assert.rejects(tool.run({ projectId: P1, text: 'x' }, { userId: USER, scope: 'hub:read' }), new RegExp(READ_ONLY_REFUSAL.slice(0, 30)));
    assert.equal(t.supabase.calls.upload.length, 0);
  } finally { await t.close(); }
});

test('a write re-checks the sign-in afresh: a token revoked a moment ago is refused even though the minute\'s cache still holds it', async () => {
  const t = await startServer();
  try {
    const client = await connect(t.url, t.tokens.access_token);
    const ok = await client.callTool({ name: 'peek_ctx', arguments: {} });
    assert.equal(ok.isError, undefined, 'the token is now in the bearer cache');
    await revokeToken(t.store, { token: t.tokens.refresh_token, client_id: t.reg.client_id }, { now: () => new Date(t.clock.ms) });
    // The request itself still passes the cache (the revocation endpoint
    // would have cleared it; here the store was revoked behind the app's
    // back, as an administrator's SQL does), but the write does not.
    const refused = await client.callTool({ name: 'save_test_note', arguments: { projectId: P1, text: 'x' } });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, `The save failed: ${SIGN_IN_ENDED_SENTENCE}`);
    assert.equal(t.supabase.calls.upload.length, 0);
    await client.close();
    // And the cache entry is gone: the next request is challenged.
    await assert.rejects(connect(t.url, t.tokens.access_token), /401|Unauthorized|invalid_token/i);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// The caps and the record, on the module alone

function writesWith({ tables = fixtures(), rpc = null, clockMs = CLOCK, errors = {} } = {}) {
  const t = { tables };
  const supabase = fakeSupabase({ tables, rpc: rpc ?? scriptedSave(t), errors });
  const lines = [];
  const writes = createProjectWrites({ supabase, hubUrl: 'https://hub.test/', now: () => new Date(clockMs), log: (l) => lines.push(l) });
  return { supabase, writes, tables, lines };
}

const actionsAt = (times, userId = USER, outcome = 'saved') => times.map((ms, i) => ({ id: `${outcome}${i}`, user_id: userId, tool: 'save_test_note', outcome, created_at: new Date(ms).toISOString() }));
const times = (n, step, offset = 1000) => Array.from({ length: n }, (_, i) => CLOCK - i * step - offset);
/** The counts checkCaps answered, with its handle released at once (as a tool's finally would). */
const counts = async (p) => { const r = await p; assert.equal(typeof r.release, 'function'); r.release(); return { hour: r.hour, day: r.day }; };

test('checkCaps counts this person\'s saved and done rows in the record: 30 in the hour and 200 in the day, whoever wrote them; refused and failed rows are not writes', async () => {
  const HOUR = 60 * 60 * 1000;
  const fresh = async () => ({ userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' });
  // 29 in the last hour: fine, and the counts come back.
  let w = writesWith({ tables: { ...fixtures(), connector_actions: actionsAt(times(29, 60_000)) } });
  assert.deepEqual(await counts(w.writes.checkCaps(ctxOf({ recheck: fresh }))), { hour: 29, day: 29 });
  // The 30th in the hour: the 31st write is refused with one sentence.
  w = writesWith({ tables: { ...fixtures(), connector_actions: actionsAt(times(30, 60_000)) } });
  await assert.rejects(w.writes.checkCaps(ctxOf({ recheck: fresh })), /^Error: You have saved 30 times from claude\.ai in the last hour, which is the limit; try again in a while, or save from the Hub\.$/);
  // Rows older than an hour do not count for the hour, but do for the day.
  w = writesWith({ tables: { ...fixtures(), connector_actions: actionsAt([...Array.from({ length: 30 }, (_, i) => CLOCK - HOUR - 1000 - i * 1000), CLOCK - 5000]) } });
  assert.deepEqual(await counts(w.writes.checkCaps(ctxOf({ recheck: fresh }))), { hour: 1, day: 31 });
  // 200 in the day (spread so no hour has 30): refused.
  w = writesWith({ tables: { ...fixtures(), connector_actions: actionsAt(times(200, 7 * 60_000)) } });
  await assert.rejects(w.writes.checkCaps(ctxOf({ recheck: fresh })), /saved 200 times from claude\.ai in the last day, which is the limit; try again tomorrow/);
  // Another person's rows and rows older than a day are not this person's.
  w = writesWith({ tables: { ...fixtures(), connector_actions: [...actionsAt(times(200, 1000), OTHER), ...actionsAt(Array.from({ length: 50 }, (_, i) => CLOCK - 25 * HOUR - i * 1000))] } });
  assert.deepEqual(await counts(w.writes.checkCaps(ctxOf({ recheck: fresh }))), { hour: 0, day: 0 });
  // Thirty refused attempts (guessed ids, stale saves) and thirty failed
  // ones (a broken renderer) in the hour wrote nothing: not counted, so
  // the person is not locked out; a "done" housekeeping row is.
  w = writesWith({ tables: { ...fixtures(), connector_actions: [...actionsAt(times(30, 60_000), USER, 'refused'), ...actionsAt(times(30, 60_000), USER, 'failed'), ...actionsAt(times(2, 60_000), USER, 'done')] } });
  assert.deepEqual(await counts(w.writes.checkCaps(ctxOf({ recheck: fresh }))), { hour: 2, day: 2 });
  w = writesWith({ tables: { ...fixtures(), connector_actions: [...actionsAt(times(200, 7 * 60_000), USER, 'refused'), ...actionsAt(times(29, 60_000), USER, 'saved')] } });
  assert.deepEqual(await counts(w.writes.checkCaps(ctxOf({ recheck: fresh }))), { hour: 29, day: 29 });
  assert.equal(HOURLY_CAP, 30); assert.equal(DAILY_CAP, 200);
});

test('two writes in flight at once at the 29th row: the writes begun here and not yet recorded count, so exactly one passes', async () => {
  const fresh = async () => ({ userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' });
  const w = writesWith({ tables: { ...fixtures(), connector_actions: actionsAt(times(29, 60_000)) } });
  // Fired together (one claude.ai turn with several saves): both count the same 29 rows.
  const results = await Promise.allSettled([w.writes.checkCaps(ctxOf({ recheck: fresh })), w.writes.checkCaps(ctxOf({ recheck: fresh }))]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected'], 'the first to begin passes, the second sees it in flight');
  assert.match(results[1].reason.message, /^You have saved 30 times from claude\.ai in the last hour/);
  assert.deepEqual([results[0].value.hour, results[0].value.day], [29, 29]);
  // While the first is still in flight (not released, not recorded) a third is refused too; once released, the count is the table's again.
  await assert.rejects(w.writes.checkCaps(ctxOf({ recheck: fresh })), /saved 30 times/);
  results[0].value.release();
  results[0].value.release();
  assert.deepEqual(await counts(w.writes.checkCaps(ctxOf({ recheck: fresh }))), { hour: 29, day: 29 }, 'release is idempotent and frees the slot');
  // A refused check leaves nothing in flight; a sign-in refusal neither.
  await assert.rejects(w.writes.checkCaps(ctxOf({ recheck: async () => null })), new RegExp(SIGN_IN_ENDED_SENTENCE.slice(0, 40)));
  assert.deepEqual(await counts(w.writes.checkCaps(ctxOf({ recheck: fresh }))), { hour: 29, day: 29 });
  // The day cap the same way: 199 rows, two at once.
  const d = writesWith({ tables: { ...fixtures(), connector_actions: actionsAt(times(199, 7 * 60_000)) } });
  const day = await Promise.allSettled([d.writes.checkCaps(ctxOf({ recheck: fresh })), d.writes.checkCaps(ctxOf({ recheck: fresh }))]);
  assert.deepEqual(day.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.match(day[1].reason.message, /saved 200 times from claude\.ai in the last day/);
  day[0].value.release();
  // A handle never released (a tool that crashed before its finally) stops counting after IN_FLIGHT_MS.
  const clock = { ms: CLOCK };
  const late = writesWith({ tables: { ...fixtures(), connector_actions: actionsAt(times(29, 60_000)) } });
  late.writes = createProjectWrites({ supabase: late.supabase, hubUrl: 'https://hub.test/', now: () => new Date(clock.ms), log: () => {} });
  await late.writes.checkCaps(ctxOf({ recheck: fresh }));
  await assert.rejects(late.writes.checkCaps(ctxOf({ recheck: fresh })), /saved 30 times/);
  clock.ms += IN_FLIGHT_MS + 1;
  const after = await late.writes.checkCaps(ctxOf({ recheck: fresh }));
  assert.equal(after.hour, 29, 'the stale entry is gone');
  after.release();
});

test('checkCaps re-checks the sign-in before counting: gone, another person\'s, or read-only is refused', async () => {
  const w = writesWith();
  await assert.rejects(w.writes.checkCaps(ctxOf({ recheck: async () => null })), new RegExp(SIGN_IN_ENDED_SENTENCE.slice(0, 40)));
  await assert.rejects(w.writes.checkCaps(ctxOf({ recheck: async () => ({ userId: OTHER, scope: DEFAULT_SCOPE }) })), new RegExp(SIGN_IN_ENDED_SENTENCE.slice(0, 40)));
  await assert.rejects(w.writes.checkCaps(ctxOf({ recheck: async () => ({ userId: USER, scope: 'hub:read' }) })), new RegExp(READ_ONLY_REFUSAL.slice(0, 30)), 'the fresh scope is what counts');
  await assert.rejects(w.writes.checkCaps(ctxOf({ scope: 'hub:read', recheck: undefined })), new RegExp(READ_ONLY_REFUSAL.slice(0, 30)), 'without a recheck the ctx scope is checked');
  await assert.rejects(w.writes.checkCaps({ userId: 'not-a-uuid' }), new RegExp(SIGN_IN_ENDED_SENTENCE.slice(0, 40)));
  assert.deepEqual(await counts(w.writes.checkCaps(ctxOf({ recheck: undefined }))), { hour: 0, day: 0 });
});

test('recordAction writes one row with the named fields only, and never the document\'s text', async () => {
  const w = writesWith();
  const id = await w.writes.recordAction(ctxOf(), { tool: 'save_test_note', projectId: P1, documentId: D1, versionId: V2, label: '  Notes   on the term sheet — saved from claude.ai ', outcome: 'saved' });
  assert.match(id, UUID_RE);
  const [row] = w.tables.connector_actions;
  assert.deepEqual(row, { id, user_id: USER, client_id: 'akh_c_test', tool: 'save_test_note', project_id: P1, document_id: D1, version_id: V2, label: 'Notes on the term sheet — saved from claude.ai', outcome: 'saved', created_at: new Date(CLOCK).toISOString() });
  assert.match(w.lines.at(-1), /^connector_actions: save_test_note saved for 1111/);
  // Defaults: outcome saved, ids null when not given or not UUIDs.
  await w.writes.recordAction(ctxOf({ clientId: undefined }), { tool: 'label_version', versionId: 'x' });
  assert.deepEqual([w.tables.connector_actions[1].client_id, w.tables.connector_actions[1].project_id, w.tables.connector_actions[1].version_id, w.tables.connector_actions[1].outcome], [null, null, null, 'saved']);
  // Refusals: a text field, a bad tool name, an unknown outcome, no user.
  await assert.rejects(w.writes.recordAction(ctxOf(), { tool: 'save_test_note', text: 'the whole memo' }), /takes only tool, projectId, documentId, versionId, label, outcome; not text\. Never the document's text\./);
  await assert.rejects(w.writes.recordAction(ctxOf(), { tool: 'save_test_note', markdown: '# memo', detail: {} }), /not markdown, detail/);
  await assert.rejects(w.writes.recordAction(ctxOf(), { tool: 'Save Note' }), /needs the tool's name/);
  await assert.rejects(w.writes.recordAction(ctxOf(), { tool: 'save_test_note', outcome: 'maybe' }), /outcome must be one of saved, done, failed, refused/);
  await assert.rejects(w.writes.recordAction({}, { tool: 'save_test_note' }), /needs the signed-in lawyer/);
  assert.equal(w.tables.connector_actions.length, 2);
});

// ---------------------------------------------------------------------------
// saveVersion

test('the storage key follows the site\'s rules, and the label says where the version came from', () => {
  assert.equal(sanitizeStorageFilename("Notes (final) & 'draft'.md"), 'Notes-final-draft.md');
  assert.equal(storageStem('Notes on the term sheet (v2)'), 'Notes-on-the-term-sheet-v2');
  assert.equal(storageStem('   '), 'file', 'the site\'s own rule: the sanitiser falls back to "file" before the stem rule can say "Document"');
  assert.equal(storageStem('x'.repeat(300)).length, 180);
  assert.deepEqual(splitFileName('Notes on the term sheet.MD'), { stem: 'Notes-on-the-term-sheet', extension: 'md' });
  assert.throws(() => splitFileName('no-extension'), /needs a name and an extension/);
  assert.throws(() => splitFileName('.md'), /needs a name and an extension/);
  assert.throws(() => splitFileName('a.tar.gz-ish!'), /needs a name and an extension/);
  const at = new Date('2026-10-20T09:00:00Z');
  assert.equal(versionLabel(null, at), 'Saved from claude.ai — 20 October 2026');
  assert.equal(versionLabel('  Notes  for  partner review ', at), 'Notes for partner review — saved from claude.ai');
  const long = versionLabel('y'.repeat(300), at);
  assert.ok(long.length <= 200 && long.endsWith('… — saved from claude.ai'));
});

test('saveVersion of a new document: upload under the site\'s path, the RPC as the lawyer with is_ai_generated false, ids and Hub links back', async () => {
  const w = writesWith();
  const bytes = Buffer.from('# Notes on the term sheet\n\nOne.', 'utf8');
  const saved = await w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: '  Notes on the term sheet  ', bytes, fileName: 'Notes on the term sheet.md' });
  assert.equal(w.supabase.calls.upload.length, 1);
  const up = w.supabase.calls.upload[0];
  assert.equal(up.bucket, BUCKET);
  assert.match(up.path, new RegExp(`^${P1}/([0-9a-f-]{36})/([0-9a-f-]{36})-Notes-on-the-term-sheet\\.md$`));
  const [, docId, objectId] = up.path.match(/^[^/]+\/([^/]+)\/([0-9a-f-]{36})-/);
  assert.match(docId, UUID_RE); assert.match(objectId, UUID_RE); assert.notEqual(docId, objectId);
  assert.equal(up.bytes, bytes.length);
  assert.deepEqual(up.opts, { contentType: 'text/markdown', upsert: false });
  assert.equal(w.supabase.calls.rpc.length, 1);
  assert.deepEqual(w.supabase.calls.rpc[0].args, {
    p_user_id: USER, p_matter_id: P1, p_document_type_id: null, p_document_id: docId, p_create_new: true, p_expected_version_id: null,
    p_title: 'Notes on the term sheet', p_storage_path: up.path, p_file_stem: 'Notes-on-the-term-sheet', p_is_ai_generated: false, p_extension: 'md',
    p_label: 'Saved from claude.ai — 20 October 2026',
  });
  assert.deepEqual(saved, {
    matterDocumentId: docId, versionId: NEW_V, versionNumber: 1, fileName: 'Notes-on-the-term-sheet-v1.md', storagePath: up.path,
    label: 'Saved from claude.ai — 20 October 2026', created: true,
    links: { project: `https://hub.test/ai/p/${P1}`, version: `https://hub.test/ai/d/${NEW_V}` },
    note: 'On file; the Hub is reading it now. Call get_document_summary on the version in about a minute.',
  });
  assert.equal(w.supabase.calls.remove.length, 0);
  assert.equal(w.supabase.calls.insert.length, 0, 'saveVersion records nothing itself: the tool does');
  assert.match(w.lines.at(-1), /^saveVersion for 1111.*: v1 of .* \(\d+ bytes, md\)$/);
  // A given mime, a given label, an AI flag asked for explicitly, a string body.
  await w.writes.saveVersion({ ctx: ctxOf(), projectId: P2, title: 'Memo', bytes: 'plain text', fileName: 'Memo.txt', mime: 'text/plain; charset=utf-8', label: 'For partner review', isAiGenerated: true });
  assert.equal(w.supabase.calls.upload[1].opts.contentType, 'text/plain');
  assert.equal(w.supabase.calls.rpc[1].args.p_label, 'For partner review — saved from claude.ai');
  assert.equal(w.supabase.calls.rpc[1].args.p_is_ai_generated, true);
});

test('saveVersion of the next version: the latest version is the expected one unless the caller names one; a stale one is refused before any upload', async () => {
  const w = writesWith();
  const saved = await w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: 'Concession Agreement', matterDocumentId: D1, bytes: Buffer.from('v3'), fileName: 'CA.docx' });
  assert.equal(saved.versionNumber, 3);
  assert.equal(saved.created, false);
  assert.equal(saved.fileName, 'CA-v3.docx');
  const args = w.supabase.calls.rpc[0].args;
  assert.equal(args.p_create_new, false);
  assert.equal(args.p_document_id, D1);
  assert.equal(args.p_expected_version_id, V2, 'the latest at the moment of saving');
  assert.equal(args.p_extension, 'docx');
  assert.match(w.supabase.calls.upload[0].path, new RegExp(`^${P1}/${D1}/[0-9a-f-]{36}-CA\\.docx$`));
  assert.equal(w.supabase.calls.upload[0].opts.contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  // The caller read v2 (now v3 exists): refused with the plan's sentence, nothing uploaded.
  await assert.rejects(w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: 'CA', matterDocumentId: D1, expectedVersion: V2, bytes: Buffer.from('v4'), fileName: 'CA.docx' }), /^Error: A newer version exists \(v3\): read it before saving the next one\.$/);
  assert.equal(w.supabase.calls.upload.length, 1);
  // Naming the right one works.
  const next = await w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: 'CA', matterDocumentId: D1, expectedVersion: NEW_V, bytes: Buffer.from('v4'), fileName: 'CA.docx' });
  assert.equal(next.versionNumber, 4);
  assert.equal(w.supabase.calls.rpc[1].args.p_expected_version_id, NEW_V);
  // A document on another project, an unknown document, bad ids.
  await assert.rejects(w.writes.saveVersion({ ctx: ctxOf(), projectId: P2, title: 'CA', matterDocumentId: D1, bytes: Buffer.from('x'), fileName: 'CA.docx' }), /That document is not on that project\./);
  await assert.rejects(w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: 'CA', matterDocumentId: V1, bytes: Buffer.from('x'), fileName: 'CA.docx' }), /There is no project document with that id/);
  await assert.rejects(w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: 'CA', matterDocumentId: 'nope', bytes: Buffer.from('x'), fileName: 'CA.docx' }), /matterDocumentId must be a document id/);
  await assert.rejects(w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: 'CA', matterDocumentId: D1, expectedVersion: 'v2', bytes: Buffer.from('x'), fileName: 'CA.docx' }), /expectedVersion must be a document version id/);
  assert.equal(w.supabase.calls.upload.length, 2);
});

test('saveVersion refuses bad input before touching storage', async () => {
  const w = writesWith();
  const base = { ctx: ctxOf(), projectId: P1, title: 'T', bytes: Buffer.from('x'), fileName: 'T.md' };
  await assert.rejects(w.writes.saveVersion({ ...base, ctx: { userId: null } }), new RegExp(SIGN_IN_ENDED_SENTENCE.slice(0, 40)));
  await assert.rejects(w.writes.saveVersion({ ...base, projectId: 'x' }), /projectId must be a project id/);
  await assert.rejects(w.writes.saveVersion({ ...base, title: '   ' }), /A title for the document is needed/);
  await assert.rejects(w.writes.saveVersion({ ...base, bytes: Buffer.alloc(0) }), /nothing to save/);
  await assert.rejects(w.writes.saveVersion({ ...base, bytes: { not: 'bytes' } }), /nothing to save/);
  await assert.rejects(w.writes.saveVersion({ ...base, bytes: Buffer.alloc(25_000_001) }), /larger than the 25 MB/);
  await assert.rejects(w.writes.saveVersion({ ...base, fileName: 'T' }), /needs a name and an extension/);
  assert.equal(w.supabase.calls.upload.length, 0);
  assert.equal(w.supabase.calls.rpc.length, 0);
});

test('when the database refuses, the upload is taken back and the reason is one sentence; a lost response after a committed save is recognised', async () => {
  // The function refuses: a colleague saved v3 between the read and the call.
  let w = writesWith({ rpc: async () => ({ data: null, error: { message: 'A newer document version exists. Reopen the latest version before saving these edits.' } }) });
  await assert.rejects(w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: 'CA', matterDocumentId: D1, bytes: Buffer.from('x'), fileName: 'CA.docx' }), /^Error: A newer version exists: a colleague saved one in the meantime, so read the latest version \(list_project_documents\) before saving again\.$/);
  assert.equal(w.supabase.calls.upload.length, 1);
  assert.deepEqual(w.supabase.calls.remove, [{ bucket: BUCKET, paths: [w.supabase.calls.upload[0].path] }], 'the object is removed again');
  assert.equal(w.supabase.objects.size, 0);
  assert.match(w.lines.at(-1), /^saveVersion for 1111.* failed on .*: A newer document version exists/);
  // The other reasons, in the lawyer's words.
  for (const [db, said] of [['Forbidden', /Only approved members of the firm can save/], ['Project is unavailable', /no longer available/], ['Document does not belong to this project and type', /not on that project/], ['The uploaded file is unavailable', /did not reach the Hub's storage/], ['connection reset', /could not save the version \(connection reset\)/]]) {
    w = writesWith({ rpc: async () => ({ data: null, error: { message: db } }) });
    await assert.rejects(w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: 'T', bytes: Buffer.from('x'), fileName: 'T.md' }), said);
    assert.equal(w.supabase.calls.remove.length, 1);
  }
  // The save committed but the response was lost: a version row holds the
  // path, so it is returned and the object stays.
  const tables = fixtures();
  w = writesWith({ tables, rpc: async (name, args) => { tables.document_versions.push({ id: NEW_V, matter_document_id: args.p_document_id, version_number: 3, storage_path: args.p_storage_path, file_name: 'CA-v3.docx' }); return { data: null, error: { message: 'fetch failed' } }; } });
  const saved = await w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: 'CA', matterDocumentId: D1, bytes: Buffer.from('x'), fileName: 'CA.docx' });
  assert.deepEqual([saved.versionId, saved.versionNumber, saved.fileName, saved.matterDocumentId], [NEW_V, 3, 'CA-v3.docx', D1]);
  assert.equal(w.supabase.calls.remove.length, 0, 'the committed object is left alone');
  // The response was lost AND the lookup after it fails (the same outage):
  // the object is not removed, since a committed row may point at it, and
  // the lawyer is told to look before saving again.
  w = writesWith({ rpc: async () => ({ data: null, error: { message: 'fetch failed' } }), errors: { document_versions: { message: 'canceling statement due to statement timeout' } } });
  await assert.rejects(w.writes.saveVersion({ ctx: ctxOf(), projectId: P1, title: 'T', bytes: Buffer.from('x'), fileName: 'T.md' }), /^Error: The Hub could not confirm whether the version was saved; check the project page before saving again\.$/);
  assert.equal(w.supabase.calls.upload.length, 1);
  assert.equal(w.supabase.calls.remove.length, 0, 'the upload stays until someone can look');
  assert.equal(w.supabase.objects.size, 1);
  assert.match(w.lines.at(-1), /the save failed \(fetch failed\) and the lookup after it too \(canceling statement due to statement timeout\); .* left in place$/);
});

test('the registry checks a write tool\'s shape and refuses a read tool that claims to write', () => {
  const base = { description: 'A tool of the wrong shape, long enough to pass the description check.', inputSchema: {}, run: async () => 'x' };
  const make = (tool) => createHubTools({ supabase: { from: () => { throw new Error('no db'); } }, voyageKey: 'v', log: () => {}, modules: [{ file: 'bad.js', tools: [tool] }], writes: {} });
  assert.throws(() => make({ ...base, name: 'w1', write: 'yes' }), /write flag must be true or false/);
  assert.throws(() => make({ ...base, name: 'w2', write: true }), /writes, so its annotations must say readOnlyHint: false/);
  assert.throws(() => make({ ...base, name: 'w3', write: true, annotations: READ_ONLY }), /must say readOnlyHint: false/);
  assert.throws(() => make({ ...base, name: 'w4', annotations: WRITE }), /not marked write: true, so its annotations must stay read-only/);
  assert.throws(() => make({ ...base, name: 'w5', annotations: 'destructive' }), /annotations must be an object/);
  assert.equal(make({ ...base, name: 'w6', write: true, annotations: WRITE }).at(-1).write, true);
  assert.equal(make({ ...base, name: 'w7', write: false }).at(-1).write, false);
  assert.deepEqual(make({ ...base, name: 'w8', annotations: READ_ONLY }).at(-1).annotations, READ_ONLY);
});
