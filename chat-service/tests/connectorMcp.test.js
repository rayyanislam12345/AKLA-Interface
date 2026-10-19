// The MCP side of the connector over its HTTP transport, driven by the MCP
// SDK's own client in-process: initialize, list the tools, call one, see a
// failed lookup come back as an error result, and the bearer check in front
// of it all. The database, the sign-in and the library are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../connector/app.js';
import { createMemoryStore } from '../connector/store.js';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES, ALL_TOOL_NAMES, WRITE_TOOL_NAMES, MAX_RESULT_CHARS } from '../connector/tools.js';
import { registerClient, issueCode, exchangeToken, DEFAULT_SCOPE, READ_SCOPE, READ_ONLY_REFUSAL } from '../connector/oauth.js';
import { createHash, randomBytes } from 'node:crypto';

const USER = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fakeSupabase(tables) {
  const chain = (table) => {
    let rows = [...(tables[table] ?? [])];
    let single = false;
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      maybeSingle() { single = true; return q; },
      then(ok, bad) { return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(ok, bad); },
    };
    return q;
  };
  return { from: chain, storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'none' } }) }) } };
}

async function signedInToken(store, scope = DEFAULT_SCOPE) {
  const client = await registerClient(store, { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  const full = await store.getClient(client.client_id);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = await issueCode(store, { client: full, userId: USER, redirectUri: client.redirect_uris[0], codeChallenge: challenge, scope });
  const tokens = await exchangeToken(store, { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier });
  return tokens.access_token;
}

async function start() {
  const store = createMemoryStore();
  const supabase = fakeSupabase({ matters: [{ id: P1, name: 'M6 Motorway', status: 'active', client: { name: 'NHA' } }] });
  const library = {
    searchLaw: async (db, key, { query }) => (query === 'boom' ? Promise.reject(new Error('The law library is unavailable')) : [{ id: 's1', act_name: 'Contract Act, 1872', section: '74', label: 'Contract Act, 1872, s.74', text: `74. Compensation for breach of contract where penalty stipulated for. (${query})`, similarity: 0.9 }]),
    readActSection: async () => { throw new Error('not in this test'); },
    searchPrecedentsTool: async () => [],
    searchProject: async () => [],
  };
  // The real modules under connector/tools/, as connector.js loads them.
  const modules = await loadToolModules();
  const tools = createHubTools({ supabase, voyageKey: 'v', library, readFile: async () => ({ blocks: [] }), log: () => {}, modules });
  const app = createApp({ store, signIn: async () => ({ ok: false, reason: 'bad_password', message: 'no' }), tools, issuer: 'https://hub.test', isMember: async (id) => id === USER, log: () => {} });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const token = await signedInToken(store);
  const readToken = await signedInToken(store, READ_SCOPE);
  return { store, url, token, readToken, close: () => new Promise((r) => server.close(r)) };
}

const connect = async (url, token) => {
  const client = new Client({ name: 'test-claude', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
};

test('initialize, list the tools and call them through the SDK client', async () => {
  const t = await start();
  try {
    const client = await connect(t.url, t.token);
    assert.equal(client.getServerVersion()?.name, 'AKLA Hub');
    assert.match(client.getInstructions() ?? '', /^Access to AKLA's Project Hub/);
    assert.match(client.getInstructions() ?? '', /Call get_firm_rules once at the start/);
    assert.match(client.getInstructions() ?? '', /Saving: the tools marked as not read-only save a new version/, 'a sign-in with hub:write is told what saving means');
    assert.match(client.getInstructions() ?? '', /nothing here can delete anything/);
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    assert.deepEqual(names.slice(0, 8), ['search_law_library', 'read_act_section', 'search_precedents', 'list_projects', 'list_project_documents', 'search_project_documents', 'read_document', 'get_document_summary']);
    assert.deepEqual(names.slice(0, 8), [...BUILT_IN_TOOL_NAMES]);
    // The loaded modules' tools follow. This sign-in carries hub:write, so
    // the slice 2 write tools are listed too, each marked so claude.ai asks
    // first (owner decision 5); everything else is read-only.
    assert.ok(names.includes('get_firm_rules'));
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names, [...ALL_TOOL_NAMES], 'claude.ai sees every tool, in registration order');
    assert.deepEqual(names.filter((n) => WRITE_TOOL_NAMES.includes(n)), [...WRITE_TOOL_NAMES], 'every write tool is listed, in order');
    for (const x of tools) {
      if (WRITE_TOOL_NAMES.includes(x.name)) {
        assert.equal(x.annotations?.readOnlyHint, false, `${x.name} writes`);
        assert.equal(x.annotations?.destructiveHint, true, `${x.name} always prompts`);
      } else {
        assert.equal(x.annotations?.readOnlyHint, true, `${x.name} is read-only`);
      }
    }
    const read = tools.find((x) => x.name === 'read_document');
    assert.deepEqual(read.inputSchema.required, ['versionId']);
    assert.equal(read.inputSchema.properties.chars.type, 'integer');
    assert.equal(read.annotations?.readOnlyHint, true);
    const law = tools.find((x) => x.name === 'search_law_library');
    assert.deepEqual(law.inputSchema.required, ['query']);
    const rules = tools.find((x) => x.name === 'get_firm_rules');
    assert.deepEqual(rules.inputSchema.properties.task.enum, ['draft', 'answer', 'review']);
    const ruleText = await client.callTool({ name: 'get_firm_rules', arguments: { task: 'answer' } });
    assert.equal(ruleText.isError, undefined);
    assert.match(ruleText.content[0].text, /^AKLA's rules for answering from the Hub\./);

    const projects = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.equal(projects.isError, undefined);
    assert.equal(projects.content[0].type, 'text');
    assert.match(projects.content[0].text, /M6 Motorway — NHA\n {2}projectId: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);

    const law74 = await client.callTool({ name: 'search_law_library', arguments: { query: 'penalty' } });
    assert.match(law74.content[0].text, /\[Source 1\] Contract Act, 1872, s\.74 \(law library\)\n74\. Compensation for breach/);
    assert.ok(law74.content[0].text.length <= MAX_RESULT_CHARS);

    // A failed lookup is an error result, not a protocol error.
    const failed = await client.callTool({ name: 'search_law_library', arguments: { query: 'boom' } });
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0].text, 'The lookup failed: The law library is unavailable');

    // A wrong argument is refused by the schema before the tool runs.
    const wrong = await client.callTool({ name: 'read_document', arguments: { versionId: 'x', chars: 'many' } });
    assert.equal(wrong.isError, true);
    await client.close();
  } finally { await t.close(); }
});

test('a read-only sign-in lists every read tool and no write tool; calling one anyway gets one sentence', async () => {
  const t = await start();
  try {
    const client = await connect(t.url, t.readToken);
    assert.match(client.getInstructions() ?? '', /This sign-in is read-only/);
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    assert.deepEqual(names, ALL_TOOL_NAMES.filter((n) => !WRITE_TOOL_NAMES.includes(n)), 'the write tools are hidden, the rest are in order');
    for (const x of tools) assert.equal(x.annotations?.readOnlyHint, true, `${x.name} is read-only`);
    for (const name of WRITE_TOOL_NAMES) {
      // Every write tool's required fields are here (zod drops the ones a tool does not take), so the refusal, not a schema error, is what comes back.
      const refused = await client.callTool({ name, arguments: { projectId: P1, versionId: P1, documentId: P1, documentTypeId: P1, title: 'x', text: 'x', markdown: 'x', content: 'x', label: 'x', status: 'drafting', templateHash: 'a'.repeat(64), ops: [{ op: 'replace', p: 1, expected: 'x', text: 'y' }] } });
      assert.equal(refused.isError, true, `${name} is refused`);
      assert.equal(refused.content[0].text, READ_ONLY_REFUSAL);
    }
    await client.close();
  } finally { await t.close(); }
});

test('without a valid token the SDK client cannot connect', async () => {
  const t = await start();
  try {
    await assert.rejects(connect(t.url, 'akh_t_made_up'), /401|Unauthorized|invalid_token/i);
    await assert.rejects(connect(t.url, ''), /401|Unauthorized/i);
  } finally { await t.close(); }
});

test('each request is served by its own server: no session id is required', async () => {
  const t = await start();
  try {
    const a = await connect(t.url, t.token);
    const b = await connect(t.url, t.token);
    const [ra, rb] = await Promise.all([a.callTool({ name: 'list_projects', arguments: {} }), b.callTool({ name: 'list_projects', arguments: {} })]);
    assert.match(ra.content[0].text, /M6 Motorway/);
    assert.match(rb.content[0].text, /M6 Motorway/);
    await a.close(); await b.close();
    // A raw POST with no session header and a token works too.
    const r = await fetch(t.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${t.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }) });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /get_document_summary/);
  } finally { await t.close(); }
});
