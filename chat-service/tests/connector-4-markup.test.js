// Slice 4 of the connector: mark up a client's draft as tracked changes
// (connector/tools/markup.js) and the stored version's Changes list it
// feeds (versionChanges.js, the /changes/* routes with { versionId }).
// Against a stub database and a stub matter-documents bucket holding a small
// real Word file built here, with the real projectWrites: the highlighted
// passage is found across two paragraphs whatever its quotes and spacing,
// and line by line when the browser added list numbers; a changed file
// (fileHash) and a stale version are refused in one sentence; more than 300
// changes are refused before anything is read; a replace and a comment land
// as tracked changes by AKLA AI and an AKLA Comments margin comment, filed
// as the next version, with the change row anchored to that version and no
// chat; the row is listed and decided in the file through the version's own
// Changes list, the decision kept beside the version; a drifted output is
// refused by the format gate with nothing saved; make_clean_copy refuses
// while a change waits, files a clean copy that keeps a rejection, and
// accepts all on the lawyer's word; a further mark-up carries the waiting
// changes forward; a hub:read sign-in never sees the write tools. No
// network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WRITE, createApp } from '../connector/app.js';
import { createMemoryStore } from '../connector/store.js';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES, MODULE_TOOL_NAMES, WRITE_TOOL_NAMES } from '../connector/tools.js';
import { registerClient, issueCode, exchangeToken, DEFAULT_SCOPE, READ_SCOPE } from '../connector/oauth.js';
import { BUCKET, createProjectWrites } from '../connector/projectWrites.js';
import { inspectDocx } from '../docxAgent.js';
import { sha256 } from '../connector/tools/fillStandardWrite.js';
import {
  createMarkupTools, locatePassage, normalizeText, paragraphRanges, markupLabel, cleanLabel, clearMarkupCache,
  SHOW_TOOL, MARKUP_TOOL, CLEAN_TOOL, FILE_CHANGED_SENTENCE, CONNECTOR_MARKUP_NOTE,
} from '../connector/tools/markup.js';
import { listVersionChanges, decideVersionChanges, versionEditRows, carryForward, HEADS_TABLE } from '../versionChanges.js';

const USER = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const V_OLD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NEW_IDS = ['f0000001-ffff-4fff-8fff-ffffffffffff', 'f0000002-ffff-4fff-8fff-ffffffffffff', 'f0000003-ffff-4fff-8fff-ffffffffffff', 'f0000004-ffff-4fff-8fff-ffffffffffff'];
const CLOCK = Date.parse('2026-10-20T09:00:00Z');
const HUB = 'https://hub.test';
const V1_PATH = `${P1}/${D1}/v1-Supply-Agreement.docx`;

// ---------------------------------------------------------------------------
// A client's draft: a heading line and four clauses, curly quotes in the
// file as Word writes them.

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const P_HEAD = 'LIMITATION OF LIABILITY';
const P_CAP = 'The Supplier’s total liability under this Agreement shall not exceed the “Contract Price”.';
const P_INDIRECT = 'Neither party shall be liable for any indirect or consequential loss.';
const P_INDEMNITY = 'The Customer shall indemnify the Supplier against all claims arising from the Customer’s use of the Services.';
const P_LAW = 'This Agreement is governed by the laws of Pakistan.';
const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const docFrom = (paras) => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
  'word/document.xml': strToU8(`<w:document ${NS}><w:body>${paras.map(para).join('')}<w:sectPr/></w:body></w:document>`),
}, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) });
const DRAFT = docFrom([P_HEAD, P_CAP, P_INDIRECT, P_INDEMNITY, P_LAW]);
const HASH = sha256(DRAFT);
const view = inspectDocx(DRAFT, { budget: Infinity });
const at = (text) => [...view.byRef].find(([, r]) => r.exactText === text)[0];
const partOf = (bytes, part) => { const e = unzipSync(bytes)[part]; return e ? strFromU8(e) : null; };
const textOf = (xml) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
const CAPPED = 'The Supplier’s total liability under this Agreement shall not exceed the fees paid by the Customer in the twelve months before the claim.';

// ---------------------------------------------------------------------------
// A database stub with the filters, inserts and updates the module, the
// foundation and versionChanges.js use; one bucket; the save function.

function fakeDb(tables, files) {
  const calls = { upload: [], remove: [], download: [], rpc: [] };
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
    calls, tables, files,
    from,
    rpc: async (name, args) => { calls.rpc.push({ name, args }); return saveFunction(tables, files, args); },
    storage: {
      from: (bucket) => ({
        upload: async (path, body, opts) => { calls.upload.push({ bucket, path, body, opts }); files[`${bucket}/${path}`] = new Uint8Array(body); return { data: { path }, error: null }; },
        remove: async (paths) => { calls.remove.push({ bucket, paths }); for (const p of paths) delete files[`${bucket}/${p}`]; return { data: paths, error: null }; },
        download: async (path) => { calls.download.push({ bucket, path }); const f = files[`${bucket}/${path}`]; return f ? { data: new Blob([f]), error: null } : { data: null, error: { message: 'Object not found' } }; },
      }),
    },
  };
}

// save_document_version_as, as the database plays it: the expected-version
// guard, the next number, the row joined to its document as the readers select it.
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
  redline_suggestions: [],
  [HEADS_TABLE]: [],
  connector_actions: [],
  profiles: [{ id: USER, full_name: 'Ayesha Khan' }],
});

const ctxOf = (extra = {}) => ({ userId: USER, clientId: 'akh_c_test', scope: DEFAULT_SCOPE, tokenId: 't1', canWrite: true, recheck: async () => ({ userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' }), ...extra });

function setup({ tables = fixtures(), draft = DRAFT, options = {} } = {}) {
  clearMarkupCache();
  const db = fakeDb(tables, { [`${BUCKET}/${V1_PATH}`]: draft });
  const lines = [];
  const log = (l) => lines.push(l);
  const real = createProjectWrites({ supabase: db, hubUrl: HUB, now: () => new Date(CLOCK), log });
  const caps = { checked: 0, released: 0 };
  const writes = { ...real, checkCaps: async (ctx) => { caps.checked += 1; const h = await real.checkCaps(ctx); return { ...h, release: () => { caps.released += 1; h.release(); } }; } };
  const modules = [{ file: 'markup.js', tools: (deps) => createMarkupTools(deps, options) }];
  const list = createHubTools({ supabase: db, voyageKey: 'v', library: { searchLaw: async () => [], readActSection: async () => { throw new Error('no'); }, searchPrecedentsTool: async () => [], searchProject: async () => [] }, readFile: async () => ({ blocks: [] }), log, hubUrl: `${HUB}/`, modules, writes, now: () => CLOCK });
  const run = (name, input, ctx = ctxOf()) => list.find((x) => x.name === name).run(input, ctx);
  return { db, tables, lines, caps, list, run };
}

const usualOps = () => [
  { op: 'replace', p: at(P_CAP), expected: P_CAP, text: CAPPED, why: 'Cap at fees paid, as instructed.' },
  { op: 'comment', p: at(P_INDEMNITY), expected: P_INDEMNITY, text: 'The indemnity is one-sided: only the Customer gives one. Ask for a mutual indemnity.' },
];
const markupInput = (extra = {}) => ({ versionId: V1, ops: usualOps(), fileHash: HASH, ...extra });
const actions = (s) => s.tables.connector_actions;
const uploadsOf = (s) => s.db.calls.upload.filter((u) => !u.path.includes('/changes/'));

// ---------------------------------------------------------------------------
// Shape

test('markup.js adds one read tool and two write tools, in the pinned lists, with the plan\'s schemas', async () => {
  const loaded = await loadToolModules();
  assert.ok(loaded.some((m) => m.file === 'markup.js'));
  const { list } = setup();
  assert.deepEqual(list.map((x) => x.name), [...BUILT_IN_TOOL_NAMES, SHOW_TOOL, MARKUP_TOOL, CLEAN_TOOL]);
  assert.deepEqual([SHOW_TOOL, MARKUP_TOOL, CLEAN_TOOL], ['show_document_paragraphs', 'apply_tracked_changes', 'make_clean_copy']);
  for (const name of [SHOW_TOOL, MARKUP_TOOL, CLEAN_TOOL]) assert.ok(MODULE_TOOL_NAMES.includes(name), `${name} is pinned`);
  assert.ok(!WRITE_TOOL_NAMES.includes(SHOW_TOOL));
  assert.ok(WRITE_TOOL_NAMES.includes(MARKUP_TOOL) && WRITE_TOOL_NAMES.includes(CLEAN_TOOL));
  const show = list.find((x) => x.name === SHOW_TOOL);
  const mark = list.find((x) => x.name === MARKUP_TOOL);
  const clean = list.find((x) => x.name === CLEAN_TOOL);
  assert.equal(show.write, undefined);
  assert.equal(show.annotations, undefined, 'read-only by default');
  for (const t of [mark, clean]) { assert.equal(t.write, true); assert.deepEqual(t.annotations, WRITE); }
  for (const k of ['versionId', 'query', 'from', 'to']) assert.ok(show.inputSchema[k] instanceof z.ZodType, `show takes ${k}`);
  for (const k of ['versionId', 'ops', 'fileHash', 'label', 'instruction']) assert.ok(mark.inputSchema[k] instanceof z.ZodType, `apply takes ${k}`);
  for (const k of ['versionId', 'acceptAll', 'label']) assert.ok(clean.inputSchema[k] instanceof z.ZodType, `clean takes ${k}`);
  assert.equal(mark.inputSchema.ops.safeParse(Array.from({ length: 301 }, () => ({ op: 'delete', p: 1, expected: 'x' }))).success, false, 'the cap is in the schema');
  assert.match(mark.description, /NEXT version of the same document/);
  assert.match(mark.description, /nothing is accepted/);
  assert.match(mark.description, /Changes list/);
  assert.match(clean.description, /Refused while a change .* is still waiting/);
  assert.match(CONNECTOR_MARKUP_NOTE, /do not end your reply with the fenced block/);
  assert.match(CONNECTOR_MARKUP_NOTE, /apply_tracked_changes/);
  assert.match(CONNECTOR_MARKUP_NOTE, /\{"read": …\} protocol is not available here/);
  assert.equal(markupLabel(null, new Date(CLOCK)), 'Marked up in claude.ai — 20 October 2026');
  assert.equal(markupLabel(' Our  comments ', new Date(CLOCK)), 'Our comments: Marked up in claude.ai — 20 October 2026');
  assert.equal(cleanLabel(null, new Date(CLOCK)), 'Clean copy — 20 October 2026');
});

// ---------------------------------------------------------------------------
// Finding the highlighted passage

test('the highlighted passage is found across two paragraphs whatever its quotes and spacing, line by line when the browser added list numbers, and loosely when retyped', async () => {
  assert.equal(normalizeText('  The “Contract  Price” — it’s '), 'the "contract price" - it\'s');
  // Straight quotes and doubled spaces against the file's curly ones, over a paragraph break.
  const pasted = 'The Supplier\'s total liability under this Agreement shall not exceed the "Contract Price".\n\nNeither  party shall be liable for any indirect';
  const found = locatePassage(view, pasted);
  assert.deepEqual(found.hits, [at(P_CAP), at(P_INDIRECT)]);
  assert.equal(found.how, 'word for word');
  // The numbers Word draws itself are not in the text: line by line.
  const numbered = locatePassage(view, '14.2\tNeither party shall be liable for any indirect or consequential loss.\n(a) The Customer shall indemnify the Supplier against all claims');
  assert.deepEqual(numbered.hits, [at(P_INDIRECT), at(P_INDEMNITY)]);
  assert.equal(numbered.how, 'line by line');
  // Retyped: the paragraph's own words are nearly all there.
  const loose = locatePassage(view, 'customer indemnify supplier claims arising customer use services');
  assert.deepEqual(loose.hits, [at(P_INDEMNITY)]);
  assert.match(loose.how, /^loosely/);
  assert.deepEqual(locatePassage(view, 'force majeure events beyond control').hits, []);
  assert.equal(paragraphRanges([2, 3, 5]), '¶2–¶3, ¶5');
  assert.equal(paragraphRanges([255, 257], [254, 255, 257, 258]), '¶255–¶257', 'an empty paragraph between does not split the passage');

  const s = setup();
  const out = await s.run(SHOW_TOOL, { versionId: V1, query: pasted });
  const lines = out.split('\n');
  assert.equal(lines[0], 'Supply Agreement v1 (Supply-Agreement-v1.docx) on Karachi Port Supply — a Word file of 5 paragraphs (¶1–¶5).');
  assert.equal(lines[1], `versionId: ${V1}`);
  assert.equal(lines[2], `fileHash: ${HASH}`);
  assert.ok(out.includes(`Open in Hub: ${HUB}/ai/d/${V1}`));
  assert.ok(out.includes('HOW TO CHANGE THE DOCUMENT'), 'the operations protocol');
  assert.ok(out.includes(CONNECTOR_MARKUP_NOTE), 'its connector form');
  assert.ok(out.includes(`The highlighted passage is ¶${at(P_CAP)}–¶${at(P_INDIRECT)}, found word for word.`));
  assert.ok(out.includes(`¶${at(P_CAP)} ${P_CAP}`), 'the paragraph with its exact text, as expected must quote it');
  assert.ok(out.includes(`¶${at(P_HEAD)} ${P_HEAD}`), 'context around the passage');
  // A range read; a PDF refused in one sentence.
  const range = await s.run(SHOW_TOOL, { versionId: V1, from: 4, to: 5 });
  assert.match(range, /PARAGRAPHS ¶4–¶5:\nPART: word\/document\.xml\n¶4 The Customer shall indemnify/);
  assert.match(range, /\[The document ends here\.\]$/);
  s.tables.document_versions.push({ id: V_OLD, matter_document_id: D1, version_number: 0, storage_path: `${P1}/${D1}/scan.pdf`, file_name: 'scan.pdf', matter_document: docJoin });
  await assert.rejects(s.run(SHOW_TOOL, { versionId: V_OLD }), /^Error: Supply Agreement v0 \(scan\.pdf\) is a PDF file, not a Word file, so it cannot be marked up as tracked changes/);
  assert.equal(s.db.calls.upload.length, 0, 'nothing written by the read');
});

// ---------------------------------------------------------------------------
// Refusals before anything is written

test('a changed file, a stale version and more than 300 changes are each refused in one sentence; nothing is uploaded', async () => {
  const s = setup();
  await assert.rejects(s.run(MARKUP_TOOL, markupInput({ fileHash: 'a'.repeat(64) })), (err) => err.message === FILE_CHANGED_SENTENCE);
  assert.equal(actions(s).at(-1).outcome, 'refused');
  await assert.rejects(s.run(MARKUP_TOOL, markupInput({ ops: Array.from({ length: 301 }, () => ({ op: 'delete', p: 2, expected: P_CAP })) })), /^Error: apply_tracked_changes takes at most 300 changes in one call \(301 were sent\)/);
  // A colleague filed v2 meanwhile: the mark-up of v1 is stale.
  s.tables.document_versions.push({ id: V_OLD, matter_document_id: D1, version_number: 2, storage_path: `${P1}/${D1}/v2.docx`, file_name: 'v2.docx', matter_document: docJoin });
  await assert.rejects(s.run(MARKUP_TOOL, markupInput()), new RegExp(`^Error: A newer version of Supply Agreement exists \\(v2, versionId ${V_OLD}\\), so nothing was saved`));
  await assert.rejects(s.run(CLEAN_TOOL, { versionId: V1, acceptAll: true }), /^Error: A newer version of Supply Agreement exists/);
  assert.equal(s.db.calls.upload.length, 0);
  assert.equal(s.db.calls.rpc.length, 0);
  assert.equal(s.caps.released, s.caps.checked, 'every handle released');
});

// ---------------------------------------------------------------------------
// The mark-up, its rows, the version's Changes list, the clean copy

test('a replace and a comment land as tracked changes by AKLA AI and an AKLA Comments comment, filed as v2 with the change row anchored to v2; the Changes list lists and decides it; the clean copy keeps the decision', async () => {
  const s = setup();
  const out = await s.run(MARKUP_TOOL, markupInput({ instruction: 'cap liability at fees paid' }));
  const NEW = NEW_IDS[0];
  // The file: the change tracked, nothing accepted, the comment in the margin.
  const up = uploadsOf(s);
  assert.equal(up.length, 1);
  assert.match(up[0].path, new RegExp(`^${P1}/${D1}/[0-9a-f-]{36}-Supply-Agreement\\.docx$`), 'the stem is the document\'s title, as the site names a version');
  const xml = partOf(up[0].body, 'word/document.xml');
  assert.match(xml, /<w:ins [^>]*w:author="AKLA AI"/);
  assert.match(xml, /<w:del [^>]*w:author="AKLA AI"/);
  assert.match(textOf(xml), /the fees paid by the Customer in the twelve months before the claim/);
  assert.match(partOf(up[0].body, 'word/comments.xml'), /w:author="AKLA Comments"[\s\S]*The indemnity is one-sided/);
  // The version: next of the same document, the lawyer's own, the label.
  const args = s.db.calls.rpc[0].args;
  assert.equal(args.p_create_new, false);
  assert.equal(args.p_document_id, D1);
  assert.equal(args.p_expected_version_id, V1);
  assert.equal(args.p_is_ai_generated, false);
  assert.equal(args.p_label, 'Marked up in claude.ai — 20 October 2026');
  assert.equal(s.db.files[`${BUCKET}/${V1_PATH}`], DRAFT, 'v1 is untouched');
  // One row, for the text change (a comment has none), on v2 with no chat.
  const rows = s.tables.redline_suggestions;
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.document_version_id, NEW);
  assert.equal(row.artifact_id, null);
  assert.equal(row.thread_id, null);
  assert.equal(row.review_type, 'edit');
  assert.equal(row.op, 'replace');
  assert.equal(row.status, 'pending');
  assert.equal(row.placement, 'placed');
  assert.equal(row.original_text, P_CAP);
  assert.equal(row.suggested_text, CAPPED);
  assert.equal(row.rationale, 'Cap at fees paid, as instructed.');
  assert.ok(row.revision_ids.length >= 1 && row.revision_ids.every((id) => id > 9000), 'ids above the floor');
  assert.equal(row.created_by, USER);
  // The record and the reply.
  assert.deepEqual(actions(s).map((a) => [a.tool, a.outcome, a.version_id]), [[MARKUP_TOOL, 'saved', NEW]]);
  const lines = out.split('\n');
  assert.equal(lines[0], `Marked up "Supply Agreement" v1 and filed it as v2 (Supply-Agreement-v2.docx), the next version of the document on Karachi Port Supply, labelled "Marked up in claude.ai — 20 October 2026".`);
  assert.equal(lines[1], 'Changes: 2 of 2 made — 1 as tracked change by AKLA AI, 1 margin comment by AKLA Comments; 0 could not be made.');
  assert.ok(out.includes('Format matches the version it was made from'), 'the format line');
  assert.ok(out.includes("1 change is waiting in v2's Changes list in the Hub"));
  assert.ok(out.includes(`Open in Hub: ${HUB}/ai/d/${NEW}`));
  assert.ok(out.includes('Nothing was accepted'));

  // The version's Changes list (POST /changes/list with { versionId }).
  const listed = await listVersionChanges(s.db, NEW);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.versionId, NEW);
  assert.equal(listed.body.head.decided, false);
  assert.equal(listed.body.changes.length, 1);
  assert.equal(listed.body.changes[0].state, 'waiting');
  assert.equal(listed.body.changes[0].canReject, true);
  assert.equal(listed.body.counts.waiting, 1);
  assert.equal(listed.body.counts.unlisted, 0, 'every AI revision in the file is a row');

  // The clean copy waits for the decision.
  await assert.rejects(s.run(CLEAN_TOOL, { versionId: NEW }), /^Error: Decide the 1 change waiting for you first\. Nothing was filed\./);

  // POST /changes/decide with { versionId }: rejected in the file, the decision kept beside v2.
  const decided = await decideVersionChanges(s.db, { versionId: NEW, decisions: [{ changeId: row.id, decision: 'rejected' }], userId: USER });
  assert.equal(decided.status, 200);
  assert.deepEqual(decided.body.notDone, []);
  assert.equal(decided.body.changes[0].state, 'rejected');
  assert.equal(decided.body.changes[0].decided.by.name, 'Ayesha Khan');
  assert.equal(row.status, 'rejected');
  assert.equal(row.decided_by, USER);
  const head = s.tables[HEADS_TABLE][0];
  assert.equal(head.document_version_id, NEW);
  assert.match(head.storage_path, new RegExp(`^${P1}/${D1}/${NEW}/changes/`));
  const headXml = partOf(s.db.files[`${BUCKET}/${head.storage_path}`], 'word/document.xml');
  assert.ok(!/<w:ins\b|<w:del\b/.test(headXml), 'the rejection is in the file');
  assert.ok(textOf(headXml).includes(P_CAP));
  // A second decision on the same change: already decided, nothing written.
  const again = await decideVersionChanges(s.db, { versionId: NEW, decisions: [{ changeId: row.id, decision: 'accepted' }], userId: USER });
  assert.equal(again.body.notDone[0].reason, 'already_decided');

  // The clean copy now files v3 from the decided copy: the rejection holds.
  const clean = await s.run(CLEAN_TOOL, { versionId: NEW });
  const cleanUp = uploadsOf(s).at(-1);
  const cleanText = textOf(partOf(cleanUp.body, 'word/document.xml'));
  assert.ok(cleanText.includes(P_CAP), 'the rejected change stays out');
  assert.ok(!cleanText.includes('twelve months'));
  assert.match(partOf(cleanUp.body, 'word/comments.xml'), /AKLA Comments/, 'comments stay');
  assert.equal(s.db.calls.rpc.at(-1).args.p_label, 'Clean copy — 20 October 2026');
  assert.match(clean, /^Filed a clean copy of "Supply Agreement" v2 as v3 /);
  assert.match(clean, /Every AKLA AI change was decided in the Hub \(0 accepted, 1 rejected and left out\); this is that decided copy\./);
  assert.equal(s.caps.released, s.caps.checked);
});

test('make_clean_copy with acceptAll accepts the waiting change as it stands and records it as the lawyer\'s decision', async () => {
  const s = setup();
  await s.run(MARKUP_TOOL, markupInput());
  const NEW = NEW_IDS[0];
  const out = await s.run(CLEAN_TOOL, { versionId: NEW, acceptAll: true, label: 'For the client' });
  const body = uploadsOf(s).at(-1).body;
  const xml = partOf(body, 'word/document.xml');
  assert.ok(!/w:author="AKLA AI"/.test(xml), 'AKLA AI\'s changes accepted');
  assert.ok(textOf(xml).includes(CAPPED));
  assert.equal(s.db.calls.rpc.at(-1).args.p_label, 'For the client: Clean copy — 20 October 2026');
  const row = s.tables.redline_suggestions[0];
  assert.equal(row.status, 'accepted');
  assert.equal(row.decided_by, USER);
  assert.match(out, /1 change still waiting was accepted as it stood, recorded as the lawyer's decision\./);
  // Nothing left to accept on a version with no AI changes.
  const s2 = setup();
  await assert.rejects(s2.run(CLEAN_TOOL, { versionId: V1 }), /^Error: Supply Agreement v1 \(Supply-Agreement-v1\.docx\) has no AKLA AI tracked changes to accept/);
});

test('the format gate refuses a drifted mark-up (a typed clause number): nothing uploaded, no row, recorded as refused', async () => {
  const before = process.env.FORMAT_GATE;
  try {
    delete process.env.FORMAT_GATE;
    const s = setup();
    await assert.rejects(
      s.run(MARKUP_TOOL, markupInput({ ops: [{ op: 'insert_after', p: at(P_LAW), expected: P_LAW, text: '17.1 The parties submit to the courts at Karachi.' }] })),
      /^Error: The format check found that this file differs from the version it was made from \(Supply-Agreement-v1\):\n- 1 paragraph starts with a typed clause number[\s\S]* v1 is unchanged\.$/,
    );
    assert.equal(s.db.calls.upload.length, 0);
    assert.equal(s.tables.redline_suggestions.length, 0);
    assert.equal(actions(s).at(-1).outcome, 'refused');
    assert.ok(s.lines.some((l) => /apply_tracked_changes: format drift \(refused\)/.test(l)));
  } finally {
    if (before === undefined) delete process.env.FORMAT_GATE; else process.env.FORMAT_GATE = before;
  }
});

test('a further mark-up of the marked-up version carries its waiting change forward; the old row says where it went', async () => {
  const s = setup();
  await s.run(MARKUP_TOOL, markupInput());
  const V2 = NEW_IDS[0];
  const listing = await s.run(SHOW_TOOL, { versionId: V2, query: 'governed by the laws of Pakistan' });
  assert.match(listing, /1 AKLA AI change is still waiting for a decision/);
  const hash = /fileHash: ([0-9a-f]{64})/.exec(listing)[1];
  const lawP = Number(/¶(\d+) This Agreement is governed/.exec(listing)[1]);
  const out = await s.run(MARKUP_TOOL, { versionId: V2, fileHash: hash, ops: [{ op: 'replace', p: lawP, expected: P_LAW, text: 'This Agreement is governed by the laws of the Islamic Republic of Pakistan.' }] });
  const V3 = NEW_IDS[1];
  const onV3 = s.tables.redline_suggestions.filter((r) => r.document_version_id === V3);
  assert.equal(onV3.length, 2, 'the carried change and the new one');
  assert.ok(onV3.every((r) => r.status === 'pending' && r.placement === 'placed'));
  const old = s.tables.redline_suggestions.find((r) => r.document_version_id === V2);
  assert.equal(old.placement, 'superseded');
  assert.match(old.placement_reason, /^Carried forward to v3/);
  assert.match(out, /2 changes are waiting in v3's Changes list/);
  assert.match(out, /1 of the changes still waiting on v2 was carried forward/);
  const listed = await listVersionChanges(s.db, V3);
  assert.equal(listed.body.counts.waiting, 2);
  assert.equal(listed.body.counts.unlisted, 0);
  assert.equal(listed.body.changes[0].before, P_CAP, 'the carried change is numbered first');
  const v2List = await listVersionChanges(s.db, V2);
  assert.equal(v2List.body.changes[0].state, 'replaced');
  assert.match(v2List.body.changes[0].stateNote, /^Carried forward to v3/);
});

test('versionEditRows and carryForward: rows off the chat onto the version; only waiting rows travel', () => {
  const { rows } = versionEditRows([
    { kind: 'replace', p: 2, status: 'applied', original: 'a', modified: 'b', revisionIds: [9001, 9002], part: 'word/document.xml' },
    { kind: 'comment', p: 3, status: 'applied', text: 'c' },
    { kind: 'delete', p: 4, status: 'skipped', reason: 'Expected paragraph text does not match the source; no change was made.', original: 'd' },
  ], { versionId: V1, userId: USER });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.document_version_id === V1 && r.artifact_id === null && r.thread_id === null && r.review_type === 'edit' && r.id));
  assert.deepEqual(rows.map((r) => [r.placement, r.placement_reason]), [['placed', null], ['unplaced', 'stale']]);
  const { clones, carried } = carryForward([
    { id: 'r1', status: 'pending', placement: 'placed', revision_ids: [9001], created_at: '2026-10-20T09:00:00Z' },
    { id: 'r2', status: 'accepted', placement: 'placed', revision_ids: [9003] },
    { id: 'r3', status: 'pending', placement: 'unplaced', revision_ids: [] },
  ], { toVersionId: V_OLD, toVersionNumber: 4 });
  assert.equal(clones.length, 1);
  assert.equal(clones[0].document_version_id, V_OLD);
  assert.equal(clones[0].created_at, '2026-10-20T09:00:00Z');
  assert.deepEqual(carried.map((c) => c.id), ['r1']);
  assert.equal(carried[0].patch.superseded_by, clones[0].id);
});

// ---------------------------------------------------------------------------
// A read-only sign-in

async function signedInToken(store, scope) {
  const client = await registerClient(store, { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  const full = await store.getClient(client.client_id);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = await issueCode(store, { client: full, userId: USER, redirectUri: client.redirect_uris[0], codeChallenge: challenge, scope });
  return (await exchangeToken(store, { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier })).access_token;
}

test('a hub:read sign-in sees show_document_paragraphs and neither write tool; hub:write sees all three', async () => {
  const store = createMemoryStore();
  const s = setup();
  const app = createApp({ store, signIn: async () => ({ ok: false, reason: 'bad_password', message: 'no' }), tools: s.list, issuer: 'https://hub.test', isMember: async (id) => id === USER, log: () => {} });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  try {
    const names = async (token) => {
      const client = new Client({ name: 'test-claude', version: '0.0.1' });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const { tools } = await client.listTools();
      await client.close();
      return tools.map((t) => t.name);
    };
    const read = await names(await signedInToken(store, READ_SCOPE));
    assert.ok(read.includes(SHOW_TOOL));
    assert.ok(!read.includes(MARKUP_TOOL) && !read.includes(CLEAN_TOOL));
    const write = await names(await signedInToken(store, DEFAULT_SCOPE));
    assert.ok(write.includes(MARKUP_TOOL) && write.includes(CLEAN_TOOL));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
