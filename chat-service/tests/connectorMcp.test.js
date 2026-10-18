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
import { createHubTools, MAX_RESULT_CHARS } from '../connector/tools.js';
import { registerClient, issueCode, exchangeToken } from '../connector/oauth.js';
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

async function signedInToken(store) {
  const client = await registerClient(store, { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  const full = await store.getClient(client.client_id);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = await issueCode(store, { client: full, userId: USER, redirectUri: client.redirect_uris[0], codeChallenge: challenge });
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
  const tools = createHubTools({ supabase, voyageKey: 'v', library, readFile: async () => ({ blocks: [] }), log: () => {} });
  const app = createApp({ store, signIn: async () => ({ ok: false, reason: 'bad_password', message: 'no' }), tools, issuer: 'https://hub.test', isMember: async (id) => id === USER, log: () => {} });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const token = await signedInToken(store);
  return { store, url, token, close: () => new Promise((r) => server.close(r)) };
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
    assert.match(client.getInstructions() ?? '', /Read-only access to AKLA's Project Hub/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name), ['search_law_library', 'read_act_section', 'search_precedents', 'list_projects', 'list_project_documents', 'search_project_documents', 'read_document', 'get_document_summary']);
    const read = tools.find((x) => x.name === 'read_document');
    assert.deepEqual(read.inputSchema.required, ['versionId']);
    assert.equal(read.inputSchema.properties.chars.type, 'integer');
    assert.equal(read.annotations?.readOnlyHint, true);
    const law = tools.find((x) => x.name === 'search_law_library');
    assert.deepEqual(law.inputSchema.required, ['query']);

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
