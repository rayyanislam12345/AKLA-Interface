// Files from a claude.ai chat into a project: upload_file_to_project and
// get_upload (connector/tools/uploads.js) over the one-time upload addresses
// (connector/uploads.js) that app.js serves at /mcp/upload/<token>. Against
// a stub database and a real HTTP server on 127.0.0.1: a small file sent as
// base64 is filed at once; without it the tool hands back an address and
// the curl line; the address shows a drop page, takes the file once (raw
// or multipart), expires, and is bound to its lawyer, project, document and
// file name; refused kinds and sizes come back as one sentence; the caps
// and the record apply as to every other save; get_upload says where an
// upload stands, even after a restart. No network beyond the loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WRITE, createApp } from '../connector/app.js';
import { createMemoryStore } from '../connector/store.js';
import { createHubTools, loadToolModules, MODULE_TOOL_NAMES, WRITE_TOOL_NAMES } from '../connector/tools.js';
import { DEFAULT_SCOPE, READ_SCOPE, READ_ONLY_REFUSAL, registerClient, issueCode, exchangeToken } from '../connector/oauth.js';
import { createProjectWrites, HOURLY_CAP } from '../connector/projectWrites.js';
import uploadsModule, { bytesOfBase64 } from '../connector/tools/uploads.js';
import { createUploads, checkFileName, fileFromMultipart, looksLike, uploadLabel, titleFromFileName, ADDRESS_TTL_MS, MAX_INLINE_BYTES, MAX_UPLOAD_BYTES, UPLOAD_PATH, UPLOAD_TOOL, STATUS_TOOL, TYPES_SENTENCE, fileUpload } from '../connector/uploads.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FAMILY = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
const CLOCK = Date.parse('2026-10-22T09:00:00Z');
const HUB = 'https://hub.test';

// A Word file's first bytes (a zip), a PDF's, and a plain text file.
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml and the rest')]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');

// ---------------------------------------------------------------------------
// The stub database (as connector-2.1-saves.test.js has it, with like/is/gt)
// and the database's save.

function fakeSupabase(tables) {
  const calls = { upload: [], remove: [], rpc: [] };
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
      like(col, pattern) { const re = new RegExp(`^${pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`); rows = rows.filter((r) => re.test(String(r[col] ?? ''))); return q; },
      maybeSingle() { single = true; return q; },
      insert(row) { inserted = row; (tables[table] ??= []).push(row); return q; },
      then(ok, bad) { return Promise.resolve({ data: inserted ? null : single ? rows[0] ?? null : rows, error: null }).then(ok, bad); },
    };
    return q;
  };
  return {
    calls, objects, tables,
    from: chain,
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      assert.equal(name, 'save_document_version_as');
      if (!objects.has(args.p_storage_path)) return { data: null, error: { message: 'The uploaded file is unavailable' } };
      const versions = (tables.document_versions ?? []).filter((v) => v.matter_document_id === args.p_document_id).sort((a, b) => b.version_number - a.version_number);
      if (!args.p_create_new && (versions[0]?.id ?? null) !== args.p_expected_version_id) return { data: null, error: { message: 'A newer document version exists.' } };
      const number = (versions[0]?.version_number ?? 0) + 1;
      const row = { id: randomUUID(), matter_document_id: args.p_document_id, version_number: number, storage_path: args.p_storage_path, file_name: `${args.p_file_stem}-v${number}.${args.p_extension}`, is_ai_generated: args.p_is_ai_generated, uploaded_by: args.p_user_id, label: args.p_label };
      (tables.document_versions ??= []).push(row);
      if (args.p_create_new) (tables.matter_documents ??= []).push({ id: args.p_document_id, title: args.p_title, matter_id: args.p_matter_id });
      return { data: { matterDocumentId: args.p_document_id, versionId: row.id, versionNumber: number, fileName: row.file_name }, error: null };
    },
    storage: {
      from: () => ({
        upload: async (path, body, opts) => { calls.upload.push({ path, body, opts }); objects.add(path); return { data: { path }, error: null }; },
        remove: async (paths) => { calls.remove.push(paths); for (const p of paths) objects.delete(p); return { data: paths, error: null }; },
        download: async () => ({ data: null, error: { message: 'none' } }),
      }),
    },
  };
}

const fixtures = () => ({
  matters: [{ id: P1, name: 'M6 Motorway', status: 'active' }, { id: P2, name: 'KPT Corridor', status: 'active' }],
  matter_documents: [{ id: D1, title: 'Share Purchase Agreement', matter_id: P1, document_type_id: null }],
  document_versions: [{ id: V1, matter_document_id: D1, version_number: 1, storage_path: `${P1}/${D1}/x-SPA.docx`, file_name: 'SPA-v1.docx', uploaded_by: USER }],
  connector_actions: [],
});

const ctxOf = (userId = USER, extra = {}) => ({ userId, clientId: 'akh_c_test', scope: DEFAULT_SCOPE, tokenId: 't1', familyId: FAMILY, canWrite: true, recheck: async () => ({ userId, scope: DEFAULT_SCOPE, tokenId: 't1', familyId: FAMILY }), ...extra });

/** The module through the registry, with real projectWrites and a real upload service, served over HTTP on the loopback. */
async function setup({ tables = fixtures(), members = new Set([USER, OTHER]), liveFamilies = new Set([FAMILY]), withUploads = true } = {}) {
  const clock = { t: CLOCK };
  const now = () => new Date(clock.t);
  const supabase = fakeSupabase(tables);
  const lines = [];
  const log = (l) => lines.push(l);
  const writes = createProjectWrites({ supabase, hubUrl: HUB, now, log });
  let app = null;
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const store = { familyLive: async (id) => liveFamilies.has(id) };
  const uploads = withUploads ? createUploads({ writes, issuer: origin, isMember: async (id) => members.has(id), store, hubUrl: HUB, now, log }) : null;
  const list = createHubTools({ supabase, voyageKey: 'v', library: { searchLaw: async () => [], readActSection: async () => { throw new Error('no'); }, searchPrecedentsTool: async () => [], searchProject: async () => [] }, readFile: async () => ({ blocks: [] }), log, hubUrl: HUB, modules: [{ file: 'uploads.js', tools: uploadsModule }], writes, uploads, now: () => clock.t });
  app = createApp({ store: createMemoryStore(), signIn: async () => ({ ok: false }), tools: list, isMember: async (id) => members.has(id), issuer: origin, log: () => {}, uploads, now });
  const byName = Object.fromEntries(list.map((x) => [x.name, x]));
  const run = (name, input, ctx = ctxOf()) => byName[name].run(input, ctx);
  return { supabase, tables, lines, writes, uploads, list, byName, run, origin, clock, members, liveFamilies, close: () => new Promise((r) => server.close(r)) };
}

const addressIn = (text) => /^Upload page: (\S+)$/m.exec(text)?.[1];
const uploadIdIn = (text) => /^uploadId: (\S+)$/m.exec(text)?.[1];
const actions = (s) => s.tables.connector_actions;
const multipart = (bytes, name) => { const fd = new FormData(); fd.append('file', new Blob([bytes]), name); return fd; };

// ---------------------------------------------------------------------------
// Shape

test('uploads.js adds a write tool and a read tool, pinned, with descriptions that say when and how', async () => {
  const loaded = await loadToolModules();
  assert.ok(loaded.some((m) => m.file === 'uploads.js'), 'the module is in the directory the connector loads');
  assert.ok(MODULE_TOOL_NAMES.includes(UPLOAD_TOOL) && MODULE_TOOL_NAMES.includes(STATUS_TOOL));
  assert.ok(WRITE_TOOL_NAMES.includes(UPLOAD_TOOL) && !WRITE_TOOL_NAMES.includes(STATUS_TOOL));
  const s = await setup();
  try {
    assert.deepEqual(s.list.slice(-2).map((t) => t.name), ['upload_file_to_project', 'get_upload']);
    const up = s.byName[UPLOAD_TOOL];
    assert.equal(up.write, true);
    assert.deepEqual(up.annotations, WRITE);
    assert.equal(s.byName[STATUS_TOOL].write, undefined, 'get_upload is read-only');
    assert.deepEqual(Object.keys(up.inputSchema).sort(), ['contentBase64', 'documentId', 'fileName', 'label', 'projectId', 'title']);
    // When to use it, the sandbox's network, and base64 for small files only.
    assert.match(up.description, /the lawyer attached a file to this chat/);
    assert.match(up.description, /made a file in your code sandbox \(with a skill/);
    assert.match(up.description, /never handed over only as a file in the chat/);
    assert.match(up.description, /may block the network: if curl fails, give the lawyer the address, written out in full on its own line/);
    assert.match(up.description, /contentBase64 files at once and is only for small files \(up to 1 MB\)/);
    assert.match(up.description, /Word, PDF, Excel, PowerPoint, image and text files, up to 50 MB/);
  } finally { await s.close(); }
});

test('the file name decides the kind: allowed kinds pass, others are refused in one sentence', () => {
  assert.deepEqual(checkFileName('Share Purchase Agreement (draft 3).DOCX').extension, 'docx');
  for (const name of ['a.pdf', 'b.xlsx', 'c.pptx', 'd.png', 'e.jpg', 'f.txt', 'g.md', 'h.doc', 'i.csv']) assert.ok(checkFileName(name).type, name);
  assert.throws(() => checkFileName('bundle.zip'), (err) => err.message === `${TYPES_SENTENCE}; a .zip file cannot be filed.` && !/\.\s+\S/.test(err.message.replace(/\(.*\)/, '')));
  assert.throws(() => checkFileName('setup.exe'), /a \.exe file cannot be filed/);
  assert.throws(() => checkFileName('no extension'), /needs a name and an extension/);
  assert.throws(() => checkFileName(''), /fileName is needed/);
  assert.equal(checkFileName('../../etc/passwd.txt').fileName, '.. .. etc passwd.txt', 'no path survives');
  assert.equal(titleFromFileName('Notes_on_the SPA.docx'), 'Notes on the SPA');
  assert.equal(uploadLabel(null, new Date(CLOCK)), 'Uploaded from claude.ai — 22 October 2026');
  assert.equal(uploadLabel('Client mark-up'), 'Client mark-up — uploaded from claude.ai');
  assert.ok(looksLike(DOCX, 'docx') && looksLike(PDF, 'pdf') && looksLike(Buffer.from('plain'), 'txt'));
  assert.ok(!looksLike(PDF, 'docx') && !looksLike(Buffer.from([0, 1, 2]), 'txt'));
  const fd = fileFromMultipart(Buffer.from('--XyZ\r\nContent-Disposition: form-data; name="file"; filename="a, b.docx"\r\nContent-Type: application/octet-stream\r\n\r\nPK\x03\x04data\r\n--XyZ--\r\n', 'latin1'), 'multipart/form-data; boundary=XyZ');
  assert.equal(fd.fileName, 'a, b.docx');
  assert.equal(fd.bytes.toString('latin1'), 'PK\x03\x04data');
});

// ---------------------------------------------------------------------------
// contentBase64

test('a small file sent as base64 is filed at once as the lawyer\'s own version, labelled, recorded and indexed by the trigger', async () => {
  const s = await setup();
  try {
    const out = await s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'Board resolution.docx', contentBase64: DOCX.toString('base64') });
    assert.match(out, /^Filed "Board resolution" as v1 \(Board-resolution-v1\.docx\), a new document on M6 Motorway, labelled "Uploaded from claude\.ai — \d{1,2} [A-Z][a-z]+ \d{4}"\./);
    assert.match(out, /^versionId: [0-9a-f-]{36}$/m);
    assert.match(out, /^Open in Hub: https:\/\/hub\.test\/ai\/d\/[0-9a-f-]{36}\?embed=1&host=pane$/m);
    assert.match(out, /mark(ed)? up|start_review/);
    const saved = s.tables.document_versions.at(-1);
    assert.equal(saved.is_ai_generated, false, 'the lawyer\'s own filing');
    assert.equal(saved.uploaded_by, USER);
    assert.equal(s.supabase.calls.upload[0].opts.contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.deepEqual(Buffer.from(s.supabase.calls.upload[0].body), DOCX);
    assert.deepEqual(actions(s).map((a) => [a.tool, a.outcome, a.user_id, a.version_id]), [[UPLOAD_TOOL, 'saved', USER, saved.id]]);
    // Indexing is the database's AFTER INSERT trigger on document_versions: nothing here asks for it.
    assert.ok(!s.supabase.calls.rpc.some((c) => /index/i.test(c.name)));

    const next = await s.run(UPLOAD_TOOL, { projectId: P1, documentId: D1, fileName: 'SPA client markup.pdf', label: 'Client mark-up', contentBase64: `data:application/pdf;base64,${PDF.toString('base64')}` });
    assert.match(next, /^Filed "Share Purchase Agreement" as v2 \(SPA-client-markup-v2\.pdf\), its next version on M6 Motorway, labelled "Client mark-up — uploaded from claude\.ai"\./);
  } finally { await s.close(); }
});

test('base64 that is too large, not base64, or not the kind its name says is refused in one sentence', async () => {
  const s = await setup();
  try {
    assert.throws(() => bytesOfBase64(Buffer.alloc(MAX_INLINE_BYTES + 10).toString('base64')), /contentBase64 is for files up to 1 MB; leave it out and use the upload address/);
    await assert.rejects(s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'x.docx', contentBase64: 'not base64 at all!' }), /contentBase64 is not base64/);
    await assert.rejects(s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'x.docx', contentBase64: PDF.toString('base64') }), /That is not a Word \(\.docx\) file, though its name says so; nothing was filed/);
    await assert.rejects(s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'x.zip', contentBase64: DOCX.toString('base64') }), /a \.zip file cannot be filed/);
    await assert.rejects(s.run(UPLOAD_TOOL, { projectId: P2, documentId: D1, fileName: 'x.docx', contentBase64: DOCX.toString('base64') }), /That document is not on KPT Corridor/);
    assert.equal(s.supabase.calls.upload.length, 0, 'nothing stored');
    assert.deepEqual(actions(s).map((a) => a.outcome), ['refused'], 'the wrong kind is on the record, as refused');
    // Past Storage's 50 MB the save is refused before anything is stored.
    const big = await fileUpload({ writes: s.writes, ctx: ctxOf(), target: { projectId: P1, projectName: 'M6 Motorway', title: 'Big', fileName: 'Big.pdf', extension: 'pdf' }, bytes: Buffer.alloc(MAX_UPLOAD_BYTES + 1) }).catch((e) => e);
    assert.equal(big.status, 413);
    assert.match(big.message, /the Hub takes at most 50 MB a file/);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// The address

test('without base64 the tool gives a one-time address and the curl line; the drop page is served; the file is filed once', async () => {
  const s = await setup();
  try {
    const out = await s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'Disclosure Letter.docx', title: 'Disclosure Letter (seller draft)' });
    const address = addressIn(out);
    const uploadId = uploadIdIn(out);
    assert.ok(address.startsWith(`${s.origin}${UPLOAD_PATH}`), 'on the connector\'s own origin, under /mcp/upload/');
    assert.match(out, new RegExp(`^curl -sS -F "file=@/mnt/user-data/uploads/Disclosure Letter\\.docx" ${address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(out, /claude\.ai's sandbox may block the network/);
    assert.match(out, /written out in full on its own line/);
    assert.match(out, /A connector restart \(a deploy\) voids an address that has not been used/);
    assert.equal(actions(s).length, 0, 'an address changes nothing, so nothing is recorded yet');

    assert.match(await s.run(STATUS_TOOL, { uploadId }), /^Not arrived yet\. The address is open until \d\d:\d\d Pakistan time \(about 30 minutes left\)/);

    const page = await fetch(address);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /Upload a file to M6 Motorway/);
    assert.match(html, /Disclosure Letter\.docx/);
    assert.match(html, /as a new document, <strong>Disclosure Letter \(seller draft\)<\/strong>/);
    assert.match(html, /#1F3864/, 'the firm\'s navy');
    assert.match(html, /name="viewport"/, 'made for a phone too');
    assert.match(html, /accept="\.docx"/);

    const res = await fetch(address, { method: 'POST', body: multipart(DOCX, 'Disclosure Letter.docx') });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.match(text, /^Filed "Disclosure Letter \(seller draft\)" as v1/);
    assert.match(text, /^Open in Hub: https:\/\/hub\.test\/ai\/d\//m);
    assert.match(text, new RegExp(`^uploadId: ${uploadId}$`, 'm'));
    const saved = s.tables.document_versions.at(-1);
    assert.ok(saved.storage_path.startsWith(`${P1}/`) && saved.storage_path.includes(`/${uploadId}-Disclosure-Letter`), 'stored under the uploadId, so it can be found after a restart');
    assert.equal(saved.uploaded_by, USER);
    assert.deepEqual(actions(s).map((a) => [a.tool, a.outcome, a.user_id]), [[UPLOAD_TOOL, 'saved', USER]]);

    // Once only.
    const again = await fetch(address, { method: 'POST', body: multipart(DOCX, 'Disclosure Letter.docx') });
    assert.equal(again.status, 409);
    assert.match(await again.text(), /already filed/);
    assert.equal(s.tables.document_versions.length, 2);
    const done = await fetch(address);
    assert.match(await done.text(), /This file is already filed/);

    const status = await s.run(STATUS_TOOL, { uploadId });
    assert.match(status, /^Arrived and filed\./);
    assert.match(status, new RegExp(`^versionId: ${saved.id}$`, 'm'));
    assert.match(status, /^Open in Hub: https:\/\/hub\.test\/ai\/d\//m);
  } finally { await s.close(); }
});

test('a raw body with the name in a header works; the page\'s JSON answer carries the Hub link', async () => {
  const s = await setup();
  try {
    const address = addressIn(await s.run(UPLOAD_TOOL, { projectId: P1, documentId: D1, fileName: 'SPA.docx' }));
    const res = await fetch(address, { method: 'POST', body: DOCX, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('SPA (signed).docx'), Accept: 'application/json' } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.versionNumber, 2, 'the next version of the target document');
    assert.match(body.hubUrl, /^https:\/\/hub\.test\/ai\/d\//);
    assert.equal(s.tables.document_versions.at(-1).matter_document_id, D1);
  } finally { await s.close(); }
});

test('the address is bound to its file name: another kind is refused and the address stays usable for the right file', async () => {
  const s = await setup();
  try {
    const address = addressIn(await s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'Opinion.docx' }));
    const wrong = await fetch(address, { method: 'POST', body: multipart(PDF, 'Opinion.pdf') });
    assert.equal(wrong.status, 415);
    assert.match(await wrong.text(), /^Not filed: This address is for a \.docx file \(Opinion\.docx\) and a \.pdf file was sent; nothing was filed/);
    const disguised = await fetch(address, { method: 'POST', body: PDF });
    assert.equal(disguised.status, 415, 'a PDF without a name is still not a Word file');
    const empty = await fetch(address, { method: 'POST', body: Buffer.alloc(0) });
    assert.equal(empty.status, 400);
    assert.equal(s.supabase.calls.upload.length, 0);
    const right = await fetch(address, { method: 'POST', body: multipart(DOCX, 'Opinion.docx') });
    assert.equal(right.status, 200);
    assert.deepEqual(actions(s).map((a) => a.outcome), ['refused', 'refused', 'refused', 'saved']);
  } finally { await s.close(); }
});

test('the address expires after 30 minutes; a made-up token finds nothing', async () => {
  const s = await setup();
  try {
    const out = await s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'Late.docx' });
    s.clock.t += ADDRESS_TTL_MS + 1000;
    const res = await fetch(addressIn(out), { method: 'POST', body: multipart(DOCX, 'Late.docx') });
    assert.equal(res.status, 410);
    assert.match(await res.text(), /expired/);
    assert.equal((await fetch(addressIn(out))).status, 410);
    assert.match(await s.run(STATUS_TOOL, { uploadId: uploadIdIn(out) }), /^No file arrived; the address expired at/);
    const made = await fetch(`${s.origin}${UPLOAD_PATH}${randomBytes(24).toString('base64url')}`);
    assert.equal(made.status, 404);
    assert.match(await made.text(), /This upload address is not valid/);
    assert.equal(s.supabase.calls.upload.length, 0);
  } finally { await s.close(); }
});

test('the address is bound to its lawyer: another lawyer cannot see it, and a withdrawn member or sign-in cannot use it', async () => {
  const s = await setup();
  try {
    const out = await s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'Mine.docx' });
    const uploadId = uploadIdIn(out);
    assert.match(await s.run(STATUS_TOOL, { uploadId }, ctxOf(OTHER)), /^No upload with that id is waiting for you/);

    s.members.delete(USER);
    const gone = await fetch(addressIn(out), { method: 'POST', body: multipart(DOCX, 'Mine.docx') });
    assert.equal(gone.status, 403);
    assert.match(await gone.text(), /sign-in to the Hub has ended or was withdrawn/);
    s.members.add(USER);
    s.liveFamilies.delete(FAMILY);
    const revoked = await fetch(addressIn(out), { method: 'POST', body: multipart(DOCX, 'Mine.docx') });
    assert.equal(revoked.status, 403, 'the connector removed in claude.ai: its tokens revoked');
    assert.equal(s.supabase.calls.upload.length, 0);
    s.liveFamilies.add(FAMILY);
    const ok = await fetch(addressIn(out), { method: 'POST', body: multipart(DOCX, 'Mine.docx') });
    assert.equal(ok.status, 200, 'refusals leave the address usable');
    assert.equal(s.tables.document_versions.at(-1).uploaded_by, USER, 'filed as the lawyer who asked, whoever sent the bytes');
  } finally { await s.close(); }
});

test('the write caps apply: at the hour\'s cap no address is given and an open one refuses the file', async () => {
  const s = await setup();
  try {
    const out = await s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'Capped.docx' });
    for (let i = 0; i < HOURLY_CAP; i++) s.tables.connector_actions.push({ id: randomUUID(), user_id: USER, tool: 'save_note_to_project', outcome: 'saved', created_at: new Date(CLOCK - 60_000).toISOString() });
    await assert.rejects(s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'More.docx' }), /which is the limit/);
    const res = await fetch(addressIn(out), { method: 'POST', body: multipart(DOCX, 'Capped.docx') });
    assert.equal(res.status, 429);
    assert.match(await res.text(), /which is the limit/);
    assert.equal(s.supabase.calls.upload.length, 0);
  } finally { await s.close(); }
});

test('get_upload finds a filed upload after a restart by its storage key; an unknown id says a restart voids an unused address', async () => {
  const s = await setup();
  try {
    const out = await s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'Survives.docx' });
    assert.equal((await fetch(addressIn(out), { method: 'POST', body: multipart(DOCX, 'Survives.docx') })).status, 200);
    // A fresh process: the same database, no memory of the address.
    const fresh = createHubTools({ supabase: s.supabase, voyageKey: 'v', log: () => {}, hubUrl: HUB, modules: [{ file: 'uploads.js', tools: uploadsModule }], writes: s.writes, uploads: createUploads({ writes: s.writes, issuer: s.origin, isMember: async () => true }) });
    const status = fresh.find((t) => t.name === STATUS_TOOL);
    const found = await status.run({ uploadId: uploadIdIn(out) }, ctxOf());
    assert.match(found, /^Arrived and filed as v1 \(Survives-v1\.docx\), labelled "Uploaded from claude\.ai — \d{1,2} [A-Z][a-z]+ \d{4}"\./);
    assert.match(found, /^Project — Open in Hub: https:\/\/hub\.test\/ai\/p\/aaaaaaaa/m);
    assert.match(await status.run({ uploadId: uploadIdIn(out) }, ctxOf(OTHER)), /^No upload with that id is waiting for you/, 'another lawyer\'s upload is not shown');
    assert.match(await status.run({ uploadId: randomUUID() }, ctxOf()), /the connector restarted before the file was sent, which voids an unused address/);
    await assert.rejects(status.run({ uploadId: 'nope' }, ctxOf()), /uploadId must be the id/);
  } finally { await s.close(); }
});

test('a connector without the upload service still offers base64 and says plainly that addresses are unavailable', async () => {
  const s = await setup({ withUploads: false });
  try {
    await assert.rejects(s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'x.docx' }), /Upload addresses are not available on this connector/);
    assert.match(await s.run(UPLOAD_TOOL, { projectId: P1, fileName: 'x.docx', contentBase64: DOCX.toString('base64') }), /^Filed "x" as v1/);
    assert.equal((await fetch(`${s.origin}${UPLOAD_PATH}${'a'.repeat(32)}`)).status, 404);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Through claude.ai's door: the MCP client, a real sign-in, the app's ctx.

async function signedInToken(store, scope = DEFAULT_SCOPE) {
  const client = await registerClient(store, { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  const full = await store.getClient(client.client_id);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = await issueCode(store, { client: full, userId: USER, redirectUri: client.redirect_uris[0], codeChallenge: challenge, scope });
  const tokens = await exchangeToken(store, { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier });
  return tokens.access_token;
}

test('end to end: the address made through MCP carries the sign-in\'s family; revoking the connector voids it; a read-only sign-in is refused', async () => {
  const tables = fixtures();
  const supabase = fakeSupabase(tables);
  const store = createMemoryStore();
  const writes = createProjectWrites({ supabase, hubUrl: HUB });
  let app = null;
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isMember = async (id) => id === USER;
  const uploads = createUploads({ writes, issuer: origin, isMember, store, hubUrl: HUB });
  const tools = createHubTools({ supabase, voyageKey: 'v', log: () => {}, hubUrl: HUB, modules: [{ file: 'uploads.js', tools: uploadsModule }], writes, uploads });
  app = createApp({ store, signIn: async () => ({ ok: false }), tools, isMember, issuer: origin, log: () => {}, uploads });
  try {
    const connect = async (token) => {
      const client = new Client({ name: 'test-claude', version: '0.0.1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    };
    const client = await connect(await signedInToken(store));
    assert.match(client.getInstructions() ?? '', /every firm document the lawyer asks you to draft is filed there, never handed over only as a file or artifact in the chat/);
    const first = await client.callTool({ name: UPLOAD_TOOL, arguments: { projectId: P1, fileName: 'One.docx' } });
    const second = await client.callTool({ name: UPLOAD_TOOL, arguments: { projectId: P1, fileName: 'Two.docx' } });
    assert.equal(first.isError, undefined, first.content[0].text);
    const ok = await fetch(addressIn(first.content[0].text), { method: 'POST', body: multipart(DOCX, 'One.docx') });
    assert.equal(ok.status, 200);
    // The lawyer removes the connector in claude.ai: every token of the family is revoked.
    for (const t of store.tokens.values()) t.revoked_at = new Date().toISOString();
    const late = await fetch(addressIn(second.content[0].text), { method: 'POST', body: multipart(DOCX, 'Two.docx') });
    assert.equal(late.status, 403);
    await client.close();

    const reader = await connect(await signedInToken(store, READ_SCOPE));
    const refused = await reader.callTool({ name: UPLOAD_TOOL, arguments: { projectId: P1, fileName: 'x.docx' } });
    assert.equal(refused.content[0].text, READ_ONLY_REFUSAL);
    await reader.close();
  } finally { await new Promise((r) => server.close(r)); }
});

// ---------------------------------------------------------------------------
// "Force connector drafting wherever possible": the rule is said where
// Claude reads it.

test('the firm rules, the drafting tools and the server instructions say a firm document is filed in the Hub, never left in the chat', async () => {
  const { firmRulesText, CONNECTOR_FILING } = await import('../connector/tools/firmRules.js');
  const draft = firmRulesText('draft');
  assert.ok(draft.includes(CONNECTOR_FILING));
  assert.match(CONNECTOR_FILING, /never handed over only as a file or artifact in the chat/);
  assert.match(CONNECTOR_FILING, /fill_standard_to_project when its type has a standard or pack \(list_document_types says which/);
  assert.match(CONNECTOR_FILING, /otherwise save_draft_to_project/);
  assert.match(CONNECTOR_FILING, /upload_file_to_project/);
  assert.match(CONNECTOR_FILING, /"Open in Hub:" address, written out in full on its own line/);
  assert.ok(!firmRulesText('answer').includes(CONNECTOR_FILING), 'an answer is not a document');
  const all = createHubTools({ supabase: fakeSupabase(fixtures()), voyageKey: 'v', log: () => {}, hubUrl: HUB, modules: await loadToolModules() });
  const byName = Object.fromEntries(all.map((t) => [t.name, t]));
  assert.match(byName.save_draft_to_project.description, /never handed over only as a file or artifact in the chat/);
  assert.match(byName.fill_standard_to_project.description, /never handed over only as a file or artifact in the chat/);
  assert.match(byName.open_standard_for_filling.description, /filed with fill_standard_to_project/);
  assert.match(byName.list_document_types.description, /fill_standard_to_project for a type with a standard or pack, save_draft_to_project otherwise/);
});
