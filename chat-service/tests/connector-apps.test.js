// The MCP Apps trial (connector/apps.js, CONNECTOR_APPS=on): the changes
// panel (ui://akla/changes) under list_changes, decide_changes and
// apply_tracked_changes, and the document panel (ui://akla/document) under
// open_document_panel. With the switch off nothing changes: the same tools,
// no extension declared, no resources. With it on: the extension declared
// in initialize, both pages listed and read with the MCP Apps mimeType and
// their _meta, the tools linked to them, structuredContent beside the same
// full text; decide_changes decides in the version's working file through
// the real projectWrites (caps, record, release), refuses a 409 in one
// sentence and is never listed for a hub:read sign-in. The two pages parse,
// load nothing from outside, and speak the host protocol in a stub DOM:
// the handshake in the SDK's order, a click becomes tools/call, a selected
// paragraph becomes the companion's own quoted message (ui/message). Against
// a stub database and bucket holding a small real Word file. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import vm from 'node:vm';
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../connector/app.js';
import { createMemoryStore } from '../connector/store.js';
import { createHubTools, loadToolModules, ALL_TOOL_NAMES, BUILT_IN_TOOL_NAMES, MODULE_TOOL_NAMES, WRITE_TOOL_NAMES } from '../connector/tools.js';
import { registerClient, issueCode, exchangeToken, DEFAULT_SCOPE, READ_SCOPE, READ_ONLY_REFUSAL } from '../connector/oauth.js';
import { BUCKET, createProjectWrites } from '../connector/projectWrites.js';
import { inspectDocx } from '../docxAgent.js';
import { sha256 } from '../connector/tools/fillStandardWrite.js';
import { clearMarkupCache, MARKUP_TOOL } from '../connector/tools/markup.js';
import { LIST_TOOL, DECIDE_TOOL, PANEL_KIND, panelData, MAX_CARD_TEXT } from '../connector/tools/changesPanel.js';
import changesPanelModule from '../connector/tools/changesPanel.js';
import documentPanelModule, { OPEN_TOOL, DOCUMENT_KIND, paragraphsOf, pageOf } from '../connector/tools/documentPanel.js';
import { APPS_EXTENSION, APP_MIME_TYPE, CHANGES_UI, DOCUMENT_UI, APP_TOOL_NAMES, APP_WRITE_TOOL_NAMES, appsOn } from '../connector/apps.js';
import { changesPanelHtml } from '../connector/changesPanelHtml.js';
import { documentPanelHtml } from '../connector/documentPanelHtml.js';
import { HEADS_TABLE } from '../versionChanges.js';

// The Chrome companion's own message builder (a plain script that sets a global).
await import('../../hub-companion/passage.js');
const { HubPassage } = globalThis;

const USER = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NEW_IDS = ['f0000001-ffff-4fff-8fff-ffffffffffff', 'f0000002-ffff-4fff-8fff-ffffffffffff', 'f0000003-ffff-4fff-8fff-ffffffffffff'];
const CLOCK = Date.parse('2026-10-21T09:00:00Z');
const HUB = 'https://hub.test';
const V1_PATH = `${P1}/${D1}/v1-Supply-Agreement.docx`;

// ---------------------------------------------------------------------------
// A client's draft (as connector-4-markup.test.js builds it).

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const P_HEAD = 'LIMITATION OF LIABILITY';
const P_CAP = 'The Supplier’s total liability under this Agreement shall not exceed the “Contract Price”.';
const P_INDIRECT = 'Neither party shall be liable for any indirect or consequential loss.';
const P_LAW = 'This Agreement is governed by the laws of Pakistan.';
const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const DRAFT = zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
  'word/document.xml': strToU8(`<w:document ${NS}><w:body>${[P_HEAD, P_CAP, P_INDIRECT, P_LAW].map(para).join('')}<w:sectPr/></w:body></w:document>`),
}, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) });
const HASH = sha256(DRAFT);
const view = inspectDocx(DRAFT, { budget: Infinity });
const at = (text) => [...view.byRef].find(([, r]) => r.exactText === text)[0];
const CAPPED = 'The Supplier’s total liability under this Agreement shall not exceed the fees paid by the Customer in the twelve months before the claim.';
const DOC_TEXT = `${P_HEAD}\n\n${P_CAP}\n\n${P_INDIRECT}\n\n${P_LAW}`;

// ---------------------------------------------------------------------------
// The stub database, bucket and save function.

function fakeDb(tables, files) {
  const calls = { upload: [], rpc: [] };
  let tick = 0;
  const stamp = () => new Date(CLOCK + (tick += 1000)).toISOString();
  const from = (table) => {
    const filters = [];
    let op = 'select';
    let payload = null;
    let single = false;
    let returning = false;
    let sort = null;
    let lim = null;
    const q = {
      select() { if (op !== 'select') returning = true; return q; },
      eq(c, v) { filters.push((r) => r[c] === v); return q; },
      is(c, v) { filters.push((r) => (r[c] ?? null) === v); return q; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
      gte(c, v) { filters.push((r) => r[c] >= v); return q; },
      order(c, { ascending = true } = {}) { sort = [c, ascending]; return q; },
      limit(k) { lim = k; return q; }, range() { return q; },
      maybeSingle() { single = true; return q; }, single() { single = true; return q; },
      insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return q; },
      update(patch) { op = 'update'; payload = patch; return q; },
      then(ok, bad) { return Promise.resolve(exec()).then(ok, bad); },
    };
    const exec = () => {
      const all = (tables[table] ??= []);
      if (op === 'insert') {
        if (table === HEADS_TABLE && payload.some((p) => all.some((r) => r.document_version_id === p.document_version_id))) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        const made = payload.map((p) => ({ created_at: stamp(), ...structuredClone(p) }));
        all.push(...made);
        return { data: returning ? made : null, error: null };
      }
      let rows = all.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        for (const r of rows) Object.assign(r, structuredClone(payload));
        return { data: returning ? rows : null, error: null };
      }
      if (sort) rows = [...rows].sort((a, b) => (a[sort[0]] < b[sort[0]] ? -1 : a[sort[0]] > b[sort[0]] ? 1 : 0) * (sort[1] ? 1 : -1));
      if (lim != null) rows = rows.slice(0, lim);
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    return q;
  };
  return {
    calls, tables, files, from,
    rpc: async (name, args) => { calls.rpc.push({ name, args }); return saveFunction(tables, files, args); },
    storage: {
      from: (bucket) => ({
        upload: async (path, body) => { calls.upload.push({ bucket, path }); files[`${bucket}/${path}`] = new Uint8Array(body); return { data: { path }, error: null }; },
        remove: async (paths) => { for (const p of paths) delete files[`${bucket}/${p}`]; return { data: paths, error: null }; },
        download: async (path) => { const f = files[`${bucket}/${path}`]; return f ? { data: new Blob([f]), error: null } : { data: null, error: { message: 'Object not found' } }; },
      }),
    },
  };
}

function saveFunction(tables, files, args) {
  if (!files[`${BUCKET}/${args.p_storage_path}`]) return { data: null, error: { message: 'The uploaded file is unavailable' } };
  const versions = tables.document_versions.filter((v) => v.matter_document_id === args.p_document_id).sort((a, b) => b.version_number - a.version_number);
  if ((versions[0]?.id ?? null) !== args.p_expected_version_id) return { data: null, error: { message: 'A newer document version exists.' } };
  const number = (versions[0]?.version_number ?? 0) + 1;
  const id = NEW_IDS[tables.document_versions.length - 1] ?? NEW_IDS.at(-1);
  const row = {
    id, matter_document_id: args.p_document_id, version_number: number, storage_path: args.p_storage_path, file_name: `${args.p_file_stem}-v${number}.${args.p_extension}`,
    is_ai_generated: args.p_is_ai_generated, uploaded_by: args.p_user_id, label: args.p_label, created_at: new Date(CLOCK + number).toISOString(),
    matter_document: versions[0].matter_document,
  };
  tables.document_versions.push(row);
  return { data: { matterDocumentId: args.p_document_id, versionId: id, versionNumber: number, fileName: row.file_name }, error: null };
}

const docJoin = { id: D1, title: 'Supply Agreement', matter_id: P1, document_type_id: null, document_type: null, matter: { id: P1, name: 'Karachi Port Supply' } };
const fixtures = () => ({
  matters: [{ id: P1, name: 'Karachi Port Supply', status: 'active' }],
  matter_documents: [{ id: D1, title: 'Supply Agreement', matter_id: P1, document_type_id: null }],
  document_versions: [{ id: V1, matter_document_id: D1, version_number: 1, storage_path: V1_PATH, file_name: 'Supply-Agreement-v1.docx', created_at: '2026-10-19T08:00:00Z', matter_document: docJoin }],
  documents: [{ document_version_id: V1, content: DOC_TEXT, char_start: 0, char_end: DOC_TEXT.length }],
  redline_suggestions: [],
  [HEADS_TABLE]: [],
  connector_actions: [],
  profiles: [{ id: USER, full_name: 'Ayesha Khan' }],
});
const ctxOf = (extra = {}) => ({ userId: USER, clientId: 'akh_c_test', scope: DEFAULT_SCOPE, tokenId: 't1', canWrite: true, recheck: async () => ({ userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' }), ...extra });
const library = { searchLaw: async () => [], readActSection: async () => { throw new Error('no'); }, searchPrecedentsTool: async () => [], searchProject: async () => [] };

async function setup({ apps = true } = {}) {
  clearMarkupCache();
  const tables = fixtures();
  const db = fakeDb(tables, { [`${BUCKET}/${V1_PATH}`]: DRAFT });
  const real = createProjectWrites({ supabase: db, hubUrl: HUB, now: () => new Date(CLOCK), log: () => {} });
  const caps = { checked: 0, released: 0 };
  const writes = { ...real, checkCaps: async (ctx) => { caps.checked += 1; const h = await real.checkCaps(ctx); return { ...h, release: () => { caps.released += 1; h.release(); } }; } };
  // Every module under connector/tools/, as connector.js loads them.
  const modules = await loadToolModules();
  const list = createHubTools({ supabase: db, voyageKey: 'v', library, readFile: async () => ({ blocks: [] }), log: () => {}, hubUrl: `${HUB}/`, modules, writes, now: () => CLOCK, apps });
  const run = (name, input, ctx = ctxOf({ apps })) => list.find((x) => x.name === name).run(input, ctx);
  return { db, tables, caps, list, run };
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

async function serve(s, { apps }) {
  const store = createMemoryStore();
  const app = createApp({ store, signIn: async () => ({ ok: false, reason: 'bad_password', message: 'no' }), tools: s.list, issuer: HUB, isMember: async (id) => id === USER, log: () => {}, apps });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const clients = [];
  // Claude's own initialize names the extension; the SDK client sends it as given.
  const connect = async (scope = DEFAULT_SCOPE) => {
    const client = new Client({ name: 'test-claude', version: '0.0.1' }, { capabilities: { extensions: { [APPS_EXTENSION]: { mimeTypes: [APP_MIME_TYPE] } } } });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${await signedInToken(store, scope)}` } } }));
    clients.push(client);
    return client;
  };
  return { connect, close: async () => { for (const c of clients) await c.close().catch(() => {}); await new Promise((r) => server.close(r)); } };
}

const markupInput = () => ({ versionId: V1, fileHash: HASH, ops: [{ op: 'replace', p: at(P_CAP), expected: P_CAP, text: CAPPED, why: 'Cap at fees paid, as instructed.' }] });
const UI_TOOLS = [LIST_TOOL, DECIDE_TOOL, MARKUP_TOOL, OPEN_TOOL];

// ---------------------------------------------------------------------------
// The switch

test('CONNECTOR_APPS: on, 1, true or yes turn the trial on; anything else, or nothing, leaves it off', () => {
  for (const v of ['on', 'ON', '1', 'true', 'yes', ' on ']) assert.equal(appsOn({ CONNECTOR_APPS: v }), true, v);
  for (const v of [undefined, '', 'off', '0', 'false', 'no', 'maybe']) assert.equal(appsOn({ CONNECTOR_APPS: v }), false, String(v));
  assert.equal(appsOn({}), false);
  assert.deepEqual(changesPanelModule({ apps: false }), [], 'the module adds nothing with the switch off');
  assert.deepEqual(documentPanelModule({}), []);
});

test('with the switch off nothing changes: the same tools in the same order, no _meta, no extension, no resources, text results', async () => {
  const s = await setup({ apps: false });
  assert.deepEqual(s.list.map((t) => t.name), [...ALL_TOOL_NAMES], 'the registry is what it was');
  const out = await s.run(MARKUP_TOOL, markupInput(), ctxOf());
  assert.equal(typeof out, 'string', 'the mark-up answers text only');
  const srv = await serve(s, { apps: false });
  try {
    const client = await srv.connect();
    const caps = client.getServerCapabilities();
    assert.equal(caps.extensions, undefined, 'no extension declared');
    assert.equal(caps.resources, undefined, 'no resources capability');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), [...ALL_TOOL_NAMES]);
    for (const t of tools) assert.equal(t._meta, undefined, `${t.name} carries no _meta`);
    await assert.rejects(client.listResources(), /Method not found/);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------------------
// The server side, on

test('with the switch on: the extension declared, both pages listed and read with the MCP Apps mimeType, _meta.ui and caching hints', async () => {
  const s = await setup();
  const srv = await serve(s, { apps: true });
  try {
    const client = await srv.connect();
    const caps = client.getServerCapabilities();
    assert.deepEqual(caps.extensions, { [APPS_EXTENSION]: { mimeTypes: [APP_MIME_TYPE] } });
    assert.equal(APPS_EXTENSION, 'io.modelcontextprotocol/ui');
    assert.equal(APP_MIME_TYPE, 'text/html;profile=mcp-app');
    assert.ok(caps.resources, 'resources declared');
    assert.ok(caps.tools);
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri), [CHANGES_UI, DOCUMENT_UI]);
    for (const r of resources) {
      assert.match(r.uri, /^ui:\/\//);
      assert.equal(r.mimeType, APP_MIME_TYPE);
      assert.deepEqual(r._meta, { ui: { prefersBorder: true } });
    }
    for (const [uri, html] of [[CHANGES_UI, changesPanelHtml], [DOCUMENT_UI, documentPanelHtml]]) {
      const read = await client.readResource({ uri });
      assert.equal(read.contents.length, 1);
      const [c] = read.contents;
      assert.equal(c.uri, uri);
      assert.equal(c.mimeType, APP_MIME_TYPE);
      assert.equal(c.text, html);
      assert.deepEqual(c._meta, { ui: { prefersBorder: true } }, 'no csp: the page loads nothing from outside');
      assert.equal(read.ttlMs, 300000);
      assert.equal(read.cacheScope, 'public');
    }
  } finally { await srv.close(); }
});

test('with the switch on: the trial tools are listed in module order, linked to their page by both keys; nothing else carries _meta', async () => {
  const s = await setup();
  assert.deepEqual(s.list.map((t) => t.name).filter((n) => !ALL_TOOL_NAMES.includes(n)), [...APP_TOOL_NAMES]);
  assert.deepEqual(s.list.filter((t) => t.write === true).map((t) => t.name).filter((n) => !WRITE_TOOL_NAMES.includes(n)), [...APP_WRITE_TOOL_NAMES]);
  const srv = await serve(s, { apps: true });
  try {
    const client = await srv.connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.deepEqual(names.slice(0, BUILT_IN_TOOL_NAMES.length), [...BUILT_IN_TOOL_NAMES]);
    assert.deepEqual(names.filter((n) => !APP_TOOL_NAMES.includes(n)), [...ALL_TOOL_NAMES], 'every tool of before, in its order');
    assert.ok(names.indexOf(LIST_TOOL) < names.indexOf('get_clause_examples'), 'changesPanel.js loads in file order');
    for (const t of tools) {
      const uri = t.name === OPEN_TOOL ? DOCUMENT_UI : CHANGES_UI;
      if (UI_TOOLS.includes(t.name)) assert.deepEqual(t._meta, { ui: { resourceUri: uri }, 'ui/resourceUri': uri }, `${t.name} points at its page`);
      else assert.equal(t._meta, undefined, `${t.name} has no page`);
    }
    const decide = tools.find((t) => t.name === DECIDE_TOOL);
    assert.equal(decide.annotations.readOnlyHint, false);
    assert.equal(decide.annotations.destructiveHint, true, 'claude.ai asks before every decision');
    assert.deepEqual(decide.inputSchema.required.sort(), ['decisions', 'versionId']);
    assert.deepEqual(decide.inputSchema.properties.decisions.items.properties.decision.enum, ['accept', 'reject']);
    assert.equal(tools.find((t) => t.name === LIST_TOOL).annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === OPEN_TOOL).annotations.readOnlyHint, true);
    assert.ok(!MODULE_TOOL_NAMES.includes(LIST_TOOL), 'pinned in apps.js, not in the module list');
  } finally { await srv.close(); }
});

test('a mark-up shows the panel: apply_tracked_changes answers its full text and the new version\'s cards as structuredContent', async () => {
  const s = await setup();
  const NEW = NEW_IDS[0];
  const out = await s.run(MARKUP_TOOL, markupInput());
  assert.equal(typeof out.text, 'string');
  assert.match(out.text, /^Marked up "Supply Agreement" v1 and filed it as v2/);
  assert.ok(out.text.includes(`versionId: ${NEW}`));
  const sc = out.structuredContent;
  assert.equal(sc.kind, PANEL_KIND);
  assert.equal(sc.versionId, NEW);
  assert.equal(sc.versionNumber, 2);
  assert.equal(sc.title, 'Supply Agreement');
  assert.equal(sc.projectName, 'Karachi Port Supply');
  assert.equal(sc.hubUrl, `${HUB}/ai/d/${NEW}`);
  assert.equal(sc.canDecide, true);
  assert.equal(sc.counts.waiting, 1);
  assert.equal(sc.changes.length, 1);
  const [card] = sc.changes;
  assert.equal(card.id, s.tables.redline_suggestions[0].id);
  assert.equal(card.number, 1);
  assert.equal(card.before, P_CAP);
  assert.equal(card.after, CAPPED);
  assert.equal(card.why, 'Cap at fees paid, as instructed.');
  assert.equal(card.state, 'waiting');
  assert.equal(card.canDecide, true);
  assert.equal(s.caps.released, s.caps.checked);
});

test('list_changes and decide_changes over MCP: text and structuredContent; a decision lands in the working file, is recorded, and the panel redraws from the reply', async () => {
  const s = await setup();
  const NEW = NEW_IDS[0];
  await s.run(MARKUP_TOOL, markupInput());
  const row = s.tables.redline_suggestions[0];
  const srv = await serve(s, { apps: true });
  try {
    const client = await srv.connect();
    const listed = await client.callTool({ name: LIST_TOOL, arguments: { versionId: NEW } });
    assert.equal(listed.isError, undefined);
    const text = listed.content[0].text;
    assert.match(text, /^Changes in "Supply Agreement" v2 on Karachi Port Supply: 1 waiting, 0 accepted, 0 rejected\./);
    assert.ok(text.includes(`changeId: ${row.id}`), 'the text fallback names each change for decide_changes');
    assert.ok(text.includes(`  Before: ${P_CAP}`) && text.includes(`  After: ${CAPPED}`));
    assert.ok(text.includes(`Open in Hub: ${HUB}/ai/d/${NEW}`));
    assert.equal(listed.structuredContent.kind, PANEL_KIND);
    assert.equal(listed.structuredContent.changes[0].id, row.id);
    assert.equal(listed.structuredContent.canDecide, true);

    const before = s.tables.connector_actions.length;
    const decided = await client.callTool({ name: DECIDE_TOOL, arguments: { versionId: NEW, decisions: [{ id: row.id, decision: 'accept' }] } });
    assert.equal(decided.isError, undefined, decided.content[0].text);
    assert.match(decided.content[0].text, /^Supply Agreement v2 \(Supply-Agreement-v2\.docx\) on Karachi Port Supply: 1 change accepted, 0 rejected\. Decided in the Hub's working copy of this version/);
    assert.match(decided.content[0].text, /Every change is decided: make_clean_copy files a clean copy/);
    const sc = decided.structuredContent;
    assert.equal(sc.message, '1 change accepted, 0 rejected.');
    assert.equal(sc.changes[0].state, 'accepted');
    assert.equal(sc.changes[0].decidedBy, 'Ayesha Khan');
    assert.equal(sc.changes[0].canDecide, false);
    assert.equal(sc.counts.accepted, 1);
    assert.equal(row.status, 'accepted');
    assert.equal(row.decided_by, USER);
    const head = s.tables[HEADS_TABLE][0];
    assert.equal(head.document_version_id, NEW, 'the decided copy is kept beside the version');
    const actions = s.tables.connector_actions.slice(before);
    assert.deepEqual(actions.map((a) => [a.tool, a.outcome, a.version_id, a.project_id, a.document_id]), [[DECIDE_TOOL, 'done', NEW, P1, D1]]);

    // Again: already decided, nothing written, said in the reply and the panel.
    const again = await client.callTool({ name: DECIDE_TOOL, arguments: { versionId: NEW, decisions: [{ id: row.id, decision: 'reject' }] } });
    assert.equal(again.isError, undefined);
    assert.equal(again.structuredContent.message, 'Nothing was decided. 1 left as it was.');
    assert.deepEqual(again.structuredContent.notDone, [{ id: row.id, note: 'This change was already accepted.' }]);
    assert.match(again.content[0].text, /- Change 1 not decided: This change was already accepted\./);
    assert.equal(row.status, 'accepted');

    // A 409 (no changes on v1) is one sentence, recorded as refused.
    const refused = await client.callTool({ name: DECIDE_TOOL, arguments: { versionId: V1, decisions: [{ id: row.id, decision: 'accept' }] } });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, 'The save failed: There are no AI changes in this document yet. Nothing was decided.');
    assert.deepEqual(s.tables.connector_actions.at(-1).outcome, 'refused');
    // A bad decision is refused before anything is read.
    const bad = await client.callTool({ name: DECIDE_TOOL, arguments: { versionId: NEW, decisions: [{ id: 'not-an-id', decision: 'accept' }] } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Each decision needs the change's id/);
    assert.equal(s.caps.released, s.caps.checked, 'every caps handle released');
  } finally { await srv.close(); }
});

test('a hub:read sign-in sees list_changes (no buttons) but never decide_changes; calling it anyway gets one sentence and records nothing', async () => {
  const s = await setup();
  await s.run(MARKUP_TOOL, markupInput());
  const NEW = NEW_IDS[0];
  const row = s.tables.redline_suggestions[0];
  const srv = await serve(s, { apps: true });
  try {
    const client = await srv.connect(READ_SCOPE);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes(LIST_TOOL) && names.includes(OPEN_TOOL));
    assert.ok(!names.includes(DECIDE_TOOL) && !names.includes(MARKUP_TOOL));
    const listed = await client.callTool({ name: LIST_TOOL, arguments: { versionId: NEW } });
    assert.equal(listed.structuredContent.canDecide, false, 'the panel hides its buttons');
    const before = s.tables.connector_actions.length;
    const tried = await client.callTool({ name: DECIDE_TOOL, arguments: { versionId: NEW, decisions: [{ id: row.id, decision: 'accept' }] } });
    assert.equal(tried.isError, true);
    assert.equal(tried.content[0].text, READ_ONLY_REFUSAL);
    assert.equal(s.tables.connector_actions.length, before);
    assert.equal(row.status, 'pending');
  } finally { await srv.close(); }
});

test('open_document_panel: a short text and the version\'s paragraphs as structuredContent, paged', async () => {
  const s = await setup();
  const srv = await serve(s, { apps: true });
  try {
    const client = await srv.connect(READ_SCOPE);
    const out = await client.callTool({ name: OPEN_TOOL, arguments: { versionId: V1 } });
    assert.equal(out.isError, undefined);
    assert.match(out.content[0].text, /^Opened Supply Agreement v1 \(Supply-Agreement-v1\.docx\) on Karachi Port Supply in the document panel \(4 paragraphs, from the stored passages\)\./);
    assert.ok(!out.content[0].text.includes(P_INDIRECT), 'the text result does not carry the document');
    const sc = out.structuredContent;
    assert.equal(sc.kind, DOCUMENT_KIND);
    assert.equal(sc.versionId, V1);
    assert.equal(sc.fileName, 'Supply-Agreement-v1.docx');
    assert.equal(sc.hubUrl, `${HUB}/ai/d/${V1}`);
    assert.deepEqual(sc.paragraphs.map((p) => p.text), [P_HEAD, P_CAP, P_INDIRECT, P_LAW]);
    assert.equal(sc.next, null);
    const second = await client.callTool({ name: OPEN_TOOL, arguments: { versionId: V1, from: 3 } });
    assert.deepEqual(second.structuredContent.paragraphs.map((p) => p.n), [3, 4]);
  } finally { await srv.close(); }
  // Paging by size, and an over-long block split.
  const paras = paragraphsOf(`a\n\n${'x'.repeat(20_000)}\n${'y'.repeat(50_000)}\nz`);
  assert.deepEqual(paras.map((p) => p.text.length), [1, 8000, 8000, 4000, 8000, 8000, 8000, 8000, 8000, 8000, 2000, 1]);
  const first = pageOf(paras, 1, 30_000);
  assert.deepEqual(first.paragraphs.map((p) => p.n), [1, 2, 3, 4, 5], 'up to the budget');
  assert.equal(first.next, 6);
  assert.equal(pageOf(paras, 11, 30_000).next, null);
});

test('the panel\'s data stays small: long texts clipped, cards past the budget counted as more', () => {
  const long = 'w'.repeat(10_000);
  const cards = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, number: i + 1, kind: 'change', where: { part: 'body', paragraph: i, clause: null }, before: long, after: long, why: null, state: 'waiting', stateLabel: 'Waiting for you', canAccept: true, canReject: true }));
  const d = panelData({ versionId: 'v', versionNumber: 2, title: 'T', projectName: 'P', hubUrl: 'h', cards, counts: { waiting: 40 }, canDecide: true });
  assert.equal(d.changes[0].before.length, MAX_CARD_TEXT);
  assert.ok(d.changes[0].before.endsWith('…'));
  assert.ok(JSON.stringify(d).length < 120_000, 'well under the ~150,000 characters Claude passes inline');
  assert.equal(d.changes.length + d.more, 40);
  assert.ok(d.more > 0);
});

// ---------------------------------------------------------------------------
// The pages

for (const [name, html] of [['changes', changesPanelHtml], ['document', documentPanelHtml]]) {
  test(`the ${name} page is one well-formed HTML document that loads nothing from outside`, () => {
    const errors = [];
    const doc = new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(`${level}: ${msg}`); } }).parseFromString(html, 'text/html');
    assert.deepEqual(errors, [], 'parses cleanly');
    assert.equal(doc.getElementsByTagName('html').length, 1);
    assert.equal(doc.getElementsByTagName('head').length, 1);
    assert.equal(doc.getElementsByTagName('body').length, 1);
    assert.equal(doc.getElementsByTagName('title').length, 1);
    assert.ok(/^<!DOCTYPE html>/.test(html));
    assert.match(html, /<meta charset="utf-8">/);
    const scripts = doc.getElementsByTagName('script');
    assert.equal(scripts.length, 1, 'one inline script');
    assert.equal(scripts[0].hasAttribute('src'), false, 'no src');
    assert.equal(doc.getElementsByTagName('link').length, 0, 'no stylesheet links');
    for (const tag of ['img', 'iframe', 'object', 'embed', 'base', 'form']) assert.equal(doc.getElementsByTagName(tag).length, 0, `no <${tag}>`);
    // No address, protocol-relative load, import, fetch or socket anywhere in the page.
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /\b(src|href|action)\s*=/i);
    assert.doesNotMatch(html, /@import|url\(/i);
    assert.doesNotMatch(html, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|\bimport\s*\(|sendBeacon|\bwindow\.open\b|\.innerHTML|document\.write/);
    // The script compiles.
    const js = html.split('<script>')[1].split('</script>')[0];
    assert.doesNotThrow(() => new vm.Script(js));
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /data-theme="dark"/);
  });
}

// A DOM just big enough for the pages: elements with children, attributes,
// listeners, text and class names; the window's parent records what the page
// posts, and the test plays the host by calling the page's message listener.
function stubPage(html, { selection = '' } = {}) {
  const posted = [];
  const parent = { postMessage: (msg, target) => { assert.equal(target, '*'); posted.push(JSON.parse(JSON.stringify(msg))); } };
  const stranger = { postMessage() {} };
  let onMessage = null;
  const byId = new Map();
  class El {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this._text = ''; this.disabled = false; this.style = { setProperty(k, v) { this[k] = v; } }; }
    appendChild(c) { this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') byId.set(String(v), this); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children = []; this._text = String(v); }
    getBoundingClientRect() { return { width: 400, height: 300 }; }
    getElementsByClassName(cls) { return walk(this).filter((n) => String(n.className).split(' ').includes(cls)); }
    click() { for (const f of this.listeners.click ?? []) f({}); }
  }
  const walk = (n) => [n, ...n.children.flatMap((c) => (c instanceof El ? walk(c) : []))];
  const textNode = (t) => ({ get textContent() { return t; } });
  const root = new El('html');
  const appEl = new El('div');
  byId.set('app', appEl);
  const docListeners = {};
  const document = {
    documentElement: root, head: new El('head'), body: new El('body'),
    createElement: (tag) => new El(tag),
    createTextNode: textNode,
    getElementById: (id) => byId.get(id) ?? null,
    addEventListener: (t, f) => { (docListeners[t] ??= []).push(f); },
  };
  const window = {
    parent,
    innerWidth: 400,
    addEventListener: (t, f) => { if (t === 'message') onMessage = f; },
    requestAnimationFrame: (f) => f(),
    getSelection: () => ({ toString: () => selection }),
  };
  const js = html.split('<script>')[1].split('</script>')[0];
  vm.runInNewContext(js, { window, document, setTimeout, clearTimeout, Promise, Uint32Array, console });
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    posted, root, app: appEl,
    host: async (data, source = parent) => { onMessage({ source, data }); await tick(); },
    buttons: (label) => walk(appEl).filter((n) => n.tagName === 'button' && (label === undefined || n.textContent === label)),
    text: () => appEl.textContent,
    setSelection: (s) => { selection = s; for (const f of docListeners.selectionchange ?? []) f({}); },
    stranger, tick,
  };
}

const HOST_CONTEXT = { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], styles: { variables: { '--color-text-primary': '#FAF9F5' } }, safeAreaInsets: { top: 0, right: 0, bottom: 20, left: 0 } };

test('the changes page: the handshake in the SDK\'s order, the result drawn, a click becomes decide_changes through the host, the reply redraws it', async () => {
  const p = stubPage(changesPanelHtml);
  // 1. ui/initialize first, as the SDK's App.connect() sends it.
  assert.equal(p.posted.length, 1);
  const init = p.posted[0];
  assert.equal(init.jsonrpc, '2.0');
  assert.equal(init.method, 'ui/initialize');
  assert.equal(init.params.protocolVersion, '2026-01-26');
  assert.deepEqual(init.params.appInfo, { name: 'AKLA changes panel', version: '0.1.0' });
  assert.deepEqual(init.params.appCapabilities, { availableDisplayModes: ['inline', 'fullscreen'] });
  // A message from anywhere but the host is ignored.
  await p.host({ jsonrpc: '2.0', id: init.id, result: { hostContext: {} } }, p.stranger);
  assert.equal(p.posted.length, 1);
  // 2. The answer: the host's look applied, then initialized, then a size.
  await p.host({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'Claude', version: '1' }, hostCapabilities: { openLinks: {}, serverTools: {}, updateModelContext: { text: {} } }, hostContext: HOST_CONTEXT } });
  assert.equal(p.posted[1].method, 'ui/notifications/initialized');
  assert.equal(p.posted[1].id, undefined);
  assert.equal(p.root.attrs['data-theme'], 'dark');
  assert.equal(p.root.style['--color-text-primary'], '#FAF9F5');
  assert.equal(p.root.style['--pad-bottom'], '20px');
  assert.ok(p.posted.some((m) => m.method === 'ui/notifications/size-changed' && m.params.width === 400 && m.params.height === 300));
  // ping is answered.
  await p.host({ jsonrpc: '2.0', id: 'h1', method: 'ping', params: {} });
  assert.deepEqual(p.posted.at(-1), { jsonrpc: '2.0', id: 'h1', result: {} });

  // 3. The tool result: the cards drawn from structuredContent.
  const card = (id, number, state = 'waiting') => ({ id, number, kind: 'change', clause: '5.1', paragraph: 12, part: 'body', before: P_CAP, after: CAPPED, why: 'Cap at fees paid.', state, stateLabel: state === 'waiting' ? 'Waiting for you' : 'Accepted', note: null, decidedBy: state === 'waiting' ? null : 'Ayesha Khan', decidedAt: null, canDecide: state === 'waiting' });
  const sc = { kind: PANEL_KIND, versionId: 'v2', versionNumber: 2, title: 'Supply Agreement', projectName: 'Karachi Port Supply', hubUrl: 'h', counts: { waiting: 2, accepted: 0, rejected: 0 }, changes: [card('c1', 1), card('c2', 2)], more: 0, canDecide: true, message: null, notDone: [], newer: null };
  await p.host({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'Marked up…' }], structuredContent: sc } });
  assert.match(p.text(), /Supply Agreement · v2 · Karachi Port Supply/);
  assert.match(p.text(), /2 waiting0 accepted0 rejected/);
  assert.equal(p.buttons('Accept').length, 2);
  assert.equal(p.buttons('Accept all 2').length, 1);
  assert.ok(p.text().includes('twelve months'), 'the new words are shown');

  // 4. Accept change 1: tools/call through the host.
  const sent = p.posted.length;
  p.buttons('Accept')[0].click();
  await p.tick();
  const call = p.posted[sent];
  assert.equal(call.method, 'tools/call');
  assert.deepEqual(call.params, { name: 'decide_changes', arguments: { versionId: 'v2', decisions: [{ id: 'c1', decision: 'accept' }] } });
  assert.ok(p.buttons('Accept').every((b) => b.disabled), 'one decision at a time');
  // The reply redraws the panel; the host is told what changed.
  const after = { ...sc, counts: { waiting: 1, accepted: 1, rejected: 0 }, changes: [card('c1', 1, 'accepted'), card('c2', 2)], message: '1 change accepted, 0 rejected.' };
  await p.host({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: after } });
  assert.match(p.text(), /1 change accepted, 0 rejected\./);
  assert.equal(p.buttons('Accept').length, 1);
  assert.match(p.text(), /Accepted by Ayesha Khan/);
  const ctxMsg = p.posted.find((m) => m.method === 'ui/update-model-context');
  assert.ok(ctxMsg, 'the model is told, where the host offers it');
  assert.match(ctxMsg.params.content[0].text, /decided changes on "Supply Agreement" v2 \(versionId v2\): 1 change accepted, 0 rejected\. Now 1 waiting, 1 accepted, 0 rejected\./);

  // 5. An error result is shown in one sentence, the list kept.
  p.buttons('Reject')[0].click();
  await p.tick();
  const rej = p.posted.filter((m) => m.method === 'tools/call').at(-1);
  await p.host({ jsonrpc: '2.0', id: rej.id, result: { isError: true, content: [{ type: 'text', text: 'The save failed: This document changed while you were deciding. Reload and try again. Nothing was decided.' }] } });
  assert.match(p.text(), /This document changed while you were deciding/);
  assert.equal(p.buttons('Refresh the list').length, 1);
  // A host that refuses the call: said plainly, with the chat as the way round.
  p.buttons('Accept')[0].click();
  await p.tick();
  const last = p.posted.filter((m) => m.method === 'tools/call').at(-1);
  await p.host({ jsonrpc: '2.0', id: last.id, error: { code: -32000, message: 'User denied' } });
  assert.match(p.text(), /Claude did not pass this on to the Hub \(User denied\)/);

  // 6. Open in Hub asks the host to open the link; teardown is answered.
  p.buttons('Open in Hub ↗')[0].click();
  await p.tick();
  assert.deepEqual(p.posted.at(-1).params, { url: 'h' });
  assert.equal(p.posted.at(-1).method, 'ui/open-link');
  await p.host({ jsonrpc: '2.0', id: 'h2', method: 'ui/resource-teardown', params: { reason: 'gone' } });
  assert.deepEqual(p.posted.at(-1), { jsonrpc: '2.0', id: 'h2', result: {} });
});

test('the changes page: Accept all asks for a second click, then sends every waiting change in one call; full screen goes through the host', async () => {
  const p = stubPage(changesPanelHtml);
  await p.host({ jsonrpc: '2.0', id: p.posted[0].id, result: { hostCapabilities: {}, hostContext: HOST_CONTEXT } });
  const card = (id, number) => ({ id, number, kind: 'change', clause: null, paragraph: number, part: 'body', before: 'a', after: 'b', why: null, state: 'waiting', stateLabel: 'Waiting for you', note: null, decidedBy: null, decidedAt: null, canDecide: true });
  await p.host({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { kind: PANEL_KIND, versionId: 'v9', versionNumber: 9, title: 'T', projectName: null, hubUrl: 'h', counts: { waiting: 3 }, changes: [card('a', 1), card('b', 2), card('c', 3)], more: 0, canDecide: true, notDone: [] } } });
  const calls = () => p.posted.filter((m) => m.method === 'tools/call');
  p.buttons('Reject all 3')[0].click();
  await p.tick();
  assert.equal(calls().length, 0, 'the first click only asks');
  p.buttons('Confirm: reject all 3')[0].click();
  await p.tick();
  assert.deepEqual(calls()[0].params.arguments, { versionId: 'v9', decisions: [{ id: 'a', decision: 'reject' }, { id: 'b', decision: 'reject' }, { id: 'c', decision: 'reject' }] });
  await p.host({ jsonrpc: '2.0', id: calls()[0].id, result: { content: [{ type: 'text', text: 'done' }] } });
  p.buttons('Full screen')[0].click();
  await p.tick();
  const mode = p.posted.at(-1);
  assert.deepEqual([mode.method, mode.params], ['ui/request-display-mode', { mode: 'fullscreen' }]);
  await p.host({ jsonrpc: '2.0', id: mode.id, result: { mode: 'fullscreen' } });
  assert.equal(p.buttons('Back to the chat').length, 1);
  // A read-only sign-in: no buttons, one line saying why.
  const q = stubPage(changesPanelHtml);
  await q.host({ jsonrpc: '2.0', id: q.posted[0].id, result: { hostContext: {} } });
  await q.host({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { kind: PANEL_KIND, versionId: 'v9', versionNumber: 9, title: 'T', hubUrl: 'h', counts: { waiting: 1 }, changes: [card('a', 1)], more: 0, canDecide: false, notDone: [] } } });
  assert.equal(q.buttons('Accept').length, 0);
  assert.match(q.text(), /This sign-in is read-only/);
  assert.equal(q.buttons('Full screen').length, 0, 'no full screen where the host does not list it');
});

test('the document page: paragraphs drawn, a selection becomes the companion\'s own quoted message (ui/message), more pages come through tools/call', async () => {
  const p = stubPage(documentPanelHtml);
  assert.equal(p.posted[0].method, 'ui/initialize');
  assert.equal(p.posted[0].params.protocolVersion, '2026-01-26');
  await p.host({ jsonrpc: '2.0', id: p.posted[0].id, result: { hostCapabilities: { message: { text: {} } }, hostContext: HOST_CONTEXT } });
  assert.equal(p.posted[1].method, 'ui/notifications/initialized');
  const sc = { kind: DOCUMENT_KIND, versionId: V1, versionNumber: 1, title: 'Supply Agreement', fileName: 'Supply-Agreement-v1.docx', projectName: 'Karachi Port Supply', hubUrl: 'h', total: 5, from: 1, next: 5, paragraphs: [P_HEAD, P_CAP, P_INDIRECT, P_LAW].map((text, i) => ({ n: i + 1, text })) };
  await p.host({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'Opened' }], structuredContent: sc } });
  assert.ok(p.text().includes(P_INDIRECT));
  assert.equal(p.buttons('Ask Claude about the selected text')[0].disabled, true, 'nothing selected yet');

  // The lawyer selects words across two paragraphs, then sends them.
  const picked = `${P_CAP}\n${P_INDIRECT}`;
  p.setSelection(picked);
  const go = p.buttons('Ask Claude about the selected text')[0];
  assert.equal(go.disabled, false);
  go.click();
  await p.tick();
  const msg = p.posted.at(-1);
  assert.equal(msg.method, 'ui/message');
  assert.equal(msg.params.role, 'user');
  const expected = HubPassage.selectionMessage({ type: 'hub:selection', text: picked, title: 'Supply Agreement', versionId: V1, versionNumber: 1, fileName: 'Supply-Agreement-v1.docx', projectName: 'Karachi Port Supply' });
  assert.deepEqual(msg.params.content, [{ type: 'text', text: expected }], 'word for word what the Chrome companion puts in the message box');
  assert.match(expected, /^In "Supply Agreement" v1 \(Supply-Agreement-v1\.docx\), project Karachi Port Supply — versionId: dddddddd/);
  await p.host({ jsonrpc: '2.0', id: msg.id, result: {} });
  assert.match(p.text(), /The passage is in the chat/);

  // A paragraph's number quotes the whole paragraph; a refusal leaves the text to copy.
  p.setSelection('');
  p.buttons('3')[0].click();
  await p.tick();
  const whole = p.posted.at(-1);
  assert.equal(whole.params.content[0].text, HubPassage.selectionMessage({ text: P_INDIRECT, title: 'Supply Agreement', versionId: V1, versionNumber: 1, fileName: 'Supply-Agreement-v1.docx', projectName: 'Karachi Port Supply' }));
  await p.host({ jsonrpc: '2.0', id: whole.id, error: { code: -32000, message: 'not supported' } });
  assert.match(p.text(), /Claude did not take the passage \(not supported\)\. Copy it from the box below/);
  assert.ok(p.text().includes('> Neither party shall be liable'));

  // The next page, through the host.
  p.buttons('Show more of the document')[0].click();
  await p.tick();
  const more = p.posted.at(-1);
  assert.deepEqual([more.method, more.params], ['tools/call', { name: 'open_document_panel', arguments: { versionId: V1, from: 5 } }]);
  await p.host({ jsonrpc: '2.0', id: more.id, result: { structuredContent: { ...sc, from: 5, next: null, paragraphs: [{ n: 5, text: 'SCHEDULE 1' }] } } });
  assert.ok(p.text().includes('SCHEDULE 1'));
  assert.equal(p.buttons('Show more of the document').length, 0);
});
