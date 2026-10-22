// Slice 5 of the connector: the Hub's review from claude.ai
// (connector/tools/reviews.js, connector/reviewRuns.js, reviewFiling.js).
// start_review answers within moments with a run id while the review runs
// detached, with the online law lookup the Hub's review makes; it refuses,
// in one sentence and on the record, a second review on the box (the Hub
// chat's own included, an abandoned or orphaned "running" row not), a
// second review of the same version, a second in this process, a fourth in
// a day, a PDF, and a server with no AI key. A run that completes files
// itself: its findings as tracked changes in the next version, through the
// real projectWrites (save, record), one change row each on that version,
// the reviewed rows saying where each went; nothing is placed over a
// version saved meanwhile. get_review reads a running review's progress and
// a complete one's filing (the new version, its counts, what could not be
// placed, the changes panel with the trial on), passes, coverage, law
// lookup and findings by clause, numbered and paged.
// apply_review_to_version files a complete review that was not filed, and
// places a filed one's findings again less the ones left out, as a fresh
// version, until a change in the filed one is decided. On SIGTERM a running
// review is aborted and marked failed with the restart sentence; at startup
// the ones an earlier process left are swept. review.js runReview calls
// onStarted once its row exists. Against a stub database and bucket holding
// a small real Word file. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { createHubTools, MODULE_TOOL_NAMES, WRITE_TOOL_NAMES, MAX_RESULT_CHARS } from '../connector/tools.js';
import { DEFAULT_SCOPE } from '../connector/oauth.js';
import { BUCKET, createProjectWrites } from '../connector/projectWrites.js';
import { WRITE } from '../connector/app.js';
import { CHANGES_UI } from '../connector/apps.js';
import { PANEL_KIND } from '../connector/tools/changesPanel.js';
import { clearMarkupCache } from '../connector/tools/markup.js';
import {
  createReviewTools, START_TOOL, GET_TOOL, APPLY_TOOL, DAILY_REVIEWS, NO_KEY_SENTENCE, BOX_BUSY_SENTENCE, orderFindings, reviewLabel, ago,
} from '../connector/tools/reviews.js';
import {
  stopReviewRuns, failOrphanedRuns, activeReviewRuns, resetReviewRuns, runLabel, runIdOfLabel, RESTART_SENTENCE, STALE_RUN_MS,
} from '../connector/reviewRuns.js';
import { runReview } from '../review.js';
import { fileReviewRun, fileFollowUp, filingOf, filingReplyText } from '../reviewFiling.js';
import { PLACEMENT_TEXT } from '../changes.js';
import { HEADS_TABLE } from '../versionChanges.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const V_PDF = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
const V_EMPTY = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3';
const NEW_V = 'f0000001-ffff-4fff-8fff-ffffffffffff';
const CLOCK = Date.parse('2026-10-21T09:00:00Z');
const HUB = 'https://hub.test';
const V1_PATH = `${P1}/${D1}/v1-Supply-Agreement.docx`;
const EMPTY_PATH = `${P1}/${D2}/v1-Side-Letter.docx`;

// ---------------------------------------------------------------------------
// A client's draft (as connector-4-markup.test.js builds it).

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const P_HEAD = 'LIMITATION OF LIABILITY';
const P_CAP = 'The Supplier’s total liability under this Agreement shall not exceed the Contract Price.';
const P_INDIRECT = 'Neither party shall be liable for any indirect or consequential loss.';
const P_LAW = 'This Agreement is governed by the laws of Pakistan.';
const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const docx = (paras) => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
  'word/document.xml': strToU8(`<w:document ${NS}><w:body>${paras.map(para).join('')}<w:sectPr/></w:body></w:document>`),
}, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) });
const DRAFT = docx([P_HEAD, P_CAP, P_INDIRECT, P_LAW]);
const EMPTY = docx([]);

// The review's findings, as complete_ai_review records them (in no order).
const FINDINGS = [
  { clause_reference: 'Governing law', review_type: 'legal_clauses', original_text: 'the laws of Pakistan', suggested_text: 'the laws of the Islamic Republic of Pakistan', rationale: 'Name the jurisdiction in full.' },
  { clause_reference: 'Clause 3', review_type: 'content_conflicts', original_text: 'any indirect or consequential loss', suggested_text: 'any indirect, special or consequential loss', rationale: 'The term sheet excludes special loss too.' },
  { clause_reference: 'Clause 2', review_type: 'legal_clauses', original_text: 'shall not exceed the Contract Price', suggested_text: 'shall not exceed the fees paid in the twelve months before the claim', rationale: 'Market practice caps at fees paid.' },
  { clause_reference: 'Clause 5', review_type: 'formatting', original_text: 'Words that are not in this document', suggested_text: 'Other words', rationale: 'Numbering.' },
];

// ---------------------------------------------------------------------------
// The stub database, bucket and save function.

function fakeDb(tables, files) {
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
      neq(c, v) { filters.push((r) => r[c] !== v); return q; },
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
        const made = payload.map((p) => ({ id: randomUUID(), created_at: stamp(), ...structuredClone(p) }));
        all.push(...made);
        return { data: returning ? (single ? made[0] : made) : null, error: null };
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
    tables, files, from,
    rpc: async (name, args) => saveFunction(tables, files, args),
    storage: {
      from: (bucket) => ({
        upload: async (path, body) => { files[`${bucket}/${path}`] = new Uint8Array(body); return { data: { path }, error: null }; },
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
  // The first version saved in a test is NEW_V; any after it a fresh id.
  const id = tables.document_versions.some((v) => v.id === NEW_V) ? randomUUID() : NEW_V;
  const row = {
    id, matter_document_id: args.p_document_id, version_number: number, storage_path: args.p_storage_path, file_name: `${args.p_file_stem}-v${number}.${args.p_extension}`,
    is_ai_generated: args.p_is_ai_generated, uploaded_by: args.p_user_id, label: args.p_label, created_at: new Date(CLOCK + number).toISOString(),
    matter_document: versions[0].matter_document,
  };
  tables.document_versions.push(row);
  return { data: { matterDocumentId: args.p_document_id, versionId: id, versionNumber: number, fileName: row.file_name }, error: null };
}

const docJoin = { id: D1, title: 'Supply Agreement', matter_id: P1, document_type_id: null, document_type: null, matter: { id: P1, name: 'Karachi Port Supply' } };
const sideJoin = { id: D2, title: 'Side Letter', matter_id: P1, document_type_id: null, document_type: null, matter: { id: P1, name: 'Karachi Port Supply' } };
const fixtures = () => ({
  matters: [{ id: P1, name: 'Karachi Port Supply', status: 'active' }],
  matter_documents: [{ id: D1, title: 'Supply Agreement', matter_id: P1, document_type_id: null }, { id: D2, title: 'Side Letter', matter_id: P1, document_type_id: null }],
  document_versions: [
    { id: V1, matter_document_id: D1, version_number: 1, storage_path: V1_PATH, file_name: 'Supply-Agreement-v1.docx', created_at: '2026-10-19T08:00:00Z', matter_document: docJoin },
    { id: V_PDF, matter_document_id: D2, version_number: 1, storage_path: `${P1}/${D2}/scan.pdf`, file_name: 'scan.pdf', created_at: '2026-10-19T08:00:00Z', matter_document: sideJoin },
    { id: V_EMPTY, matter_document_id: D2, version_number: 2, storage_path: EMPTY_PATH, file_name: 'Side-Letter-v2.docx', created_at: '2026-10-19T09:00:00Z', matter_document: sideJoin },
  ],
  ai_review_runs: [],
  redline_suggestions: [],
  [HEADS_TABLE]: [],
  connector_actions: [],
  profiles: [{ id: USER, full_name: 'Ayesha Khan' }],
});
const ctxOf = (extra = {}) => ({ userId: USER, clientId: 'akh_c_test', scope: DEFAULT_SCOPE, tokenId: 't1', canWrite: true, recheck: async () => ({ userId: USER, scope: DEFAULT_SCOPE, tokenId: 't1' }), ...extra });
const library = { searchLaw: async () => [], readActSection: async () => { throw new Error('no'); }, searchPrecedentsTool: async () => [], searchProject: async () => [] };
const iso = (ms) => new Date(ms).toISOString();

/**
 * A stand-in for review.js runReview with its contract: the run row first,
 * onStarted(id), then it waits until the test completes or fails it, or
 * its signal is aborted (when it marks itself failed with the abort's
 * words, as reviewDocument's catch does, unless told to ignore the signal).
 */
function fakeRunner({ startedAgoMs = 45_000, ignoreSignal = false } = {}) {
  const runs = [];
  const run = async ({ supabase, documentVersionId, userId, signal, onStarted, lookUpLaw }) => {
    const id = randomUUID();
    supabase.tables.ai_review_runs.push({ id, document_version_id: documentVersionId, artifact_id: null, status: 'running', passes: {}, coverage: { documentCharacters: 4000, sectionsCompleted: 1, sectionsTotal: 2, exhaustive: false }, error: null, created_by: userId, created_at: iso(CLOCK - startedAgoMs) });
    let finish, fail;
    const gate = new Promise((ok, bad) => { finish = ok; fail = bad; });
    runs.push({ id, finish, fail, lookUpLaw, signal });
    onStarted(id);
    if (!ignoreSignal) {
      signal.addEventListener('abort', () => {
        const row = supabase.tables.ai_review_runs.find((r) => r.id === id);
        if (row.status === 'running') Object.assign(row, { status: 'failed', error: 'This operation was aborted' });
        fail(new Error('This operation was aborted'));
      }, { once: true });
    }
    await gate;
    return { suggestions: [] };
  };
  return { run, runs };
}

/** Completes a run as complete_ai_review would: the findings, then status complete. */
function complete(db, runId, findings = FINDINGS, versionId = V1) {
  const row = db.tables.ai_review_runs.find((r) => r.id === runId);
  for (const f of findings) {
    db.tables.redline_suggestions.push({
      id: randomUUID(), document_version_id: versionId, review_run_id: runId, artifact_id: null, thread_id: null, message_id: null, status: 'pending', op: 'replace', part: 'word/document.xml', paragraph_index: null,
      revision_ids: [], placement: 'placed', placement_reason: null, superseded_by: null, created_by: USER, decided_by: null, decided_at: null, created_at: iso(CLOCK - 1000), ...f,
    });
  }
  Object.assign(row, {
    status: 'complete',
    passes: {
      legal_clauses: { status: 'reviewed', findings: 2 },
      formatting: { status: 'not_checked', findings: 1, note: 'A reference standard and a Word source are required for structural formatting comparison.' },
      content_conflicts: { status: 'partial', findings: 1, note: 'Compared retrieved excerpts, not every project document.' },
    },
    coverage: { documentCharacters: 4000, sectionsCompleted: 1, sectionsTotal: 1, statuteExcerpts: 3, precedentExcerpts: 2, projectExcerpts: 0, droppedUnlocated: 1, research: null, exhaustive: false },
  });
}

function setup({ runner = fakeRunner(), anthropicKey = 'sk-test', apps = false } = {}) {
  const lookups = [];
  resetReviewRuns();
  clearMarkupCache();
  const tables = fixtures();
  const db = fakeDb(tables, { [`${BUCKET}/${V1_PATH}`]: DRAFT, [`${BUCKET}/${EMPTY_PATH}`]: EMPTY });
  const real = createProjectWrites({ supabase: db, hubUrl: HUB, now: () => new Date(CLOCK), log: () => {} });
  const caps = { checked: 0, released: 0 };
  const writes = { ...real, checkCaps: async (ctx) => { caps.checked += 1; const h = await real.checkCaps(ctx); return { ...h, release: () => { caps.released += 1; h.release(); } }; } };
  // The online law lookup, made per review for the lawyer who started it.
  const lawLookup = ({ ctx, signal }) => { lookups.push({ userId: ctx.userId, signal }); return async () => ({ status: 'not_run', unresolved: ['stub'] }); };
  const module = (deps) => createReviewTools(deps, { run: runner.run ?? runner, startTimeoutMs: 2_000, lawLookup });
  const list = createHubTools({ supabase: db, voyageKey: 'v', anthropicKey, library, readFile: async () => ({ blocks: [] }), log: () => {}, hubUrl: `${HUB}/`, modules: [{ file: 'reviews.js', tools: module }], writes, now: () => CLOCK, apps });
  const tool = (name) => list.find((x) => x.name === name);
  const run = (name, input, ctx = ctxOf({ apps })) => tool(name).run(input, ctx);
  return { db, tables, caps, list, tool, run, runner, lookups };
}

/** Lets the detached run's settling (and the slot's release) happen. */
const settle = () => new Promise((r) => setImmediate(r));
const runIdOf = (text) => /runId: ([0-9a-f-]{36})/.exec(text)[1];
const actions = (s, tool) => s.tables.connector_actions.filter((a) => !tool || a.tool === tool);

// ---------------------------------------------------------------------------
// The registry

test('the three tools are pinned; start and apply are writes (destructive, like every write tool), get_review reads; apply links the changes panel', () => {
  for (const name of [START_TOOL, GET_TOOL, APPLY_TOOL]) assert.ok(MODULE_TOOL_NAMES.includes(name), `${name} is pinned`);
  assert.deepEqual([START_TOOL, GET_TOOL, APPLY_TOOL], ['start_review', 'get_review', 'apply_review_to_version']);
  assert.ok(WRITE_TOOL_NAMES.includes(START_TOOL) && WRITE_TOOL_NAMES.includes(APPLY_TOOL));
  assert.ok(!WRITE_TOOL_NAMES.includes(GET_TOOL));
  const s = setup();
  assert.equal(s.tool(START_TOOL).write, true);
  assert.deepEqual(s.tool(START_TOOL).annotations, WRITE);
  assert.equal(s.tool(START_TOOL).annotations.destructiveHint, true);
  assert.deepEqual(s.tool(APPLY_TOOL).annotations, WRITE);
  assert.equal(s.tool(APPLY_TOOL).ui, CHANGES_UI);
  assert.equal(s.tool(GET_TOOL).write, undefined);
  assert.equal(s.tool(GET_TOOL).annotations, undefined, 'read-only by default');
  for (const name of [START_TOOL, GET_TOOL, APPLY_TOOL]) assert.match(s.tool(name).description, /not legal approval|not an exhaustive|suggestions, not/);
  resetReviewRuns();
});

test('the pieces: labels, the record label, the order of findings, ages', () => {
  assert.equal(reviewLabel(null, new Date(CLOCK)), 'Review suggestions placed — 21 October 2026');
  assert.equal(reviewLabel('For the client', new Date(CLOCK)), 'For the client: Review suggestions placed — 21 October 2026');
  const id = randomUUID();
  assert.equal(runIdOfLabel(runLabel(id)), id);
  assert.equal(runIdOfLabel('Saved from claude.ai'), null);
  const ordered = orderFindings(FINDINGS.map((f, i) => ({ ...f, id: `id${i}` })));
  assert.deepEqual(ordered.map((f) => f.clause_reference), ['Clause 2', 'Clause 3', 'Clause 5', 'Governing law']);
  assert.deepEqual(orderFindings([{ id: 'b', clause_reference: 'Section 10.1' }, { id: 'a', clause_reference: 'Section 2.10' }, { id: 'c', clause_reference: 'Section 2.9' }]).map((f) => f.id), ['c', 'a', 'b']);
  assert.equal(ago(45_000), '45 s');
  assert.equal(ago(12 * 60_000), '12 min');
});

// ---------------------------------------------------------------------------
// start_review

test('start_review answers at once with the run id while the review runs detached; the record carries the run id', async () => {
  const s = setup();
  const t0 = Date.now();
  const out = await s.run(START_TOOL, { versionId: V1 });
  assert.ok(Date.now() - t0 < 1000, 'it does not wait for the review');
  const runId = runIdOf(out);
  assert.match(out, /Started the Hub's review of Supply Agreement v1/);
  assert.match(out, new RegExp(`versionId: ${V1}`));
  assert.match(out, new RegExp(`Open in Hub: ${HUB}/`));
  assert.match(out, /looked up online first, as in the Hub/);
  assert.match(out, /When it is complete it files itself/);
  assert.match(out, /get_review/);
  assert.deepEqual(activeReviewRuns().map((r) => r.runId), [runId], 'running in this process');
  assert.equal(typeof s.runner.runs[0].lookUpLaw, 'function', 'the online law lookup, as the Hub review makes it');
  assert.deepEqual(s.lookups.map((l) => l.userId), [USER], 'made for the lawyer who started the review');
  assert.equal(s.lookups[0].signal, s.runner.runs[0].signal, 'stopped with the review');
  const [rec] = actions(s, START_TOOL);
  assert.equal(rec.outcome, 'done');
  assert.equal(rec.label, runLabel(runId));
  assert.equal(rec.version_id, V1);
  assert.equal(s.caps.released, s.caps.checked, 'the caps handle is released');
  // The review finishes later; the slot is free again.
  s.runner.runs[0].finish();
  await settle(); await settle();
  assert.deepEqual(activeReviewRuns(), []);
  resetReviewRuns();
});

test('one review on the box: a Hub chat review running elsewhere refuses the start; an abandoned or orphaned "running" row does not', async () => {
  const s = setup();
  s.tables.ai_review_runs.push({ id: randomUUID(), document_version_id: V_EMPTY, status: 'running', created_at: iso(CLOCK - 5 * 60_000) });
  await assert.rejects(s.run(START_TOOL, { versionId: V1 }), (err) => err.message === BOX_BUSY_SENTENCE);
  assert.equal(actions(s, START_TOOL)[0].outcome, 'refused');
  assert.equal(s.runner.runs.length, 0, 'nothing started');
  assert.equal(s.caps.released, s.caps.checked);

  // Older than the bound: abandoned, not running.
  s.tables.ai_review_runs[0].created_at = iso(CLOCK - STALE_RUN_MS - 60_000);
  // Started by the connector, but no process here runs it: an earlier process's orphan.
  const orphan = randomUUID();
  s.tables.ai_review_runs.push({ id: orphan, document_version_id: V_EMPTY, status: 'running', created_at: iso(CLOCK - 60_000) });
  s.tables.connector_actions.push({ id: randomUUID(), user_id: OTHER, tool: START_TOOL, label: runLabel(orphan), outcome: 'done', created_at: iso(CLOCK - 60_000) });
  const out = await s.run(START_TOOL, { versionId: V1 });
  assert.match(out, /Started the Hub's review/);
  s.runner.runs[0].finish();
  await settle(); await settle();
  resetReviewRuns();
});

test('a second review of the same version is refused while one runs, naming the run to read', async () => {
  const s = setup();
  const running = randomUUID();
  s.tables.ai_review_runs.push({ id: running, document_version_id: V1, status: 'running', created_at: iso(CLOCK - 90_000) });
  await assert.rejects(s.run(START_TOOL, { versionId: V1 }), (err) => {
    assert.match(err.message, /A review of Supply Agreement v1 .* is already running \(started 90 s ago\)/);
    assert.match(err.message, new RegExp(`get_review with runId ${running}`));
    return true;
  });
  assert.equal(actions(s, START_TOOL)[0].outcome, 'refused');
  resetReviewRuns();
});

test('one review per process: a second start while one runs here is refused, and the slot is not lost to the refusal', async () => {
  const s = setup();
  await s.run(START_TOOL, { versionId: V1 });
  await assert.rejects(s.run(START_TOOL, { versionId: V_EMPTY }), (err) => err.message === BOX_BUSY_SENTENCE);
  s.runner.runs[0].finish();
  await settle(); await settle();
  const again = await s.run(START_TOOL, { versionId: V_EMPTY });
  assert.match(again, /Started the Hub's review of Side Letter v2/);
  s.runner.runs[1].finish();
  await settle(); await settle();
  resetReviewRuns();
});

test(`at most ${DAILY_REVIEWS} reviews a day per person, counted from connector_actions`, async () => {
  const s = setup();
  for (let i = 0; i < DAILY_REVIEWS; i++) s.tables.connector_actions.push({ id: randomUUID(), user_id: USER, tool: START_TOOL, label: runLabel(randomUUID()), outcome: 'done', created_at: iso(CLOCK - (i + 1) * 3600_000) });
  // Someone else's, a refused one and yesterday's do not count.
  s.tables.connector_actions.push({ id: randomUUID(), user_id: OTHER, tool: START_TOOL, outcome: 'done', created_at: iso(CLOCK - 60_000) });
  await assert.rejects(s.run(START_TOOL, { versionId: V1 }), /You have started 3 reviews from claude.ai in the last day, which is the limit/);
  assert.equal(s.runner.runs.length, 0);
  s.tables.connector_actions[0].created_at = iso(CLOCK - 25 * 3600_000);
  assert.match(await s.run(START_TOOL, { versionId: V1 }), /Started/);
  s.runner.runs[0].finish();
  await settle(); await settle();
  resetReviewRuns();
});

test('no AI key on the server: start_review says so in one sentence and nothing is started; a PDF is refused', async () => {
  const s = setup({ anthropicKey: null });
  await assert.rejects(s.run(START_TOOL, { versionId: V1 }), (err) => err.message === NO_KEY_SENTENCE);
  assert.equal(s.runner.runs.length, 0);
  const t = setup();
  await assert.rejects(t.run(START_TOOL, { versionId: V_PDF }), /is a PDF file\. The review is started from claude.ai on Word \(\.docx\) versions only/);
  assert.equal(actions(t, START_TOOL)[0].outcome, 'refused');
  resetReviewRuns();
});

test('with the real runReview: onStarted gives the run id at once, and a review that then fails is read back as failed', async () => {
  const s = setup({ runner: runReview });
  const out = await s.run(START_TOOL, { versionId: V_EMPTY });
  const runId = runIdOf(out);
  const row = s.tables.ai_review_runs.find((r) => r.id === runId);
  assert.ok(row, 'the run row is the one reviewDocument inserted');
  assert.equal(row.document_version_id, V_EMPTY);
  assert.equal(row.created_by, USER);
  // The empty file has no text: the review fails on its own, and frees the slot.
  for (let i = 0; i < 20 && row.status !== 'failed'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(row.status, 'failed');
  await settle(); await settle();
  assert.deepEqual(activeReviewRuns(), []);
  const read = await s.run(GET_TOOL, { runId });
  assert.match(read, /Status: failed\. No text content could be extracted from the document/);
  assert.match(read, new RegExp(`Open in Hub: ${HUB}/`));
  resetReviewRuns();
});

// ---------------------------------------------------------------------------
// get_review

test('get_review while running: how long and how far; when complete: passes, coverage and findings by clause, numbered', async () => {
  const s = setup();
  const runId = runIdOf(await s.run(START_TOOL, { versionId: V1 }));
  const running = await s.run(GET_TOOL, { runId });
  assert.match(running, /Status: still running \(started 45 s ago; 1 of 2 sections of the document checked\)/);
  assert.match(running, new RegExp(`Open in Hub: ${HUB}/`));

  complete(s.db, runId);
  s.runner.runs[0].finish();
  await settle(); await settle();
  const done = await s.run(GET_TOOL, { runId });
  assert.match(done, /Status: complete\. 4 findings\./);
  assert.match(done, /- legal clauses and citations: reviewed, 2 findings/);
  assert.match(done, /- content and conflicts: partial, 1 finding\. Compared retrieved excerpts/);
  assert.match(done, /COVERAGE: 4,000 characters in 1 section; evidence: 3 law, 2 precedent and 0 project excerpts/);
  assert.match(done, /LAW LOOKUP: not run for this review/);
  assert.match(done, /not an exhaustive legal clearance/);
  // Filed on its own when it completed.
  assert.match(done, /FILED: the findings were placed as tracked changes by AKLA AI in v2 of "Supply Agreement"/);
  assert.match(done, new RegExp(`versionId: ${NEW_V}\nOpen in Hub: ${HUB}/ai/d/${NEW_V}`));
  assert.match(done, /Changes in v2: 3 waiting, 0 accepted, 0 rejected\./);
  assert.match(done, /Could not be placed \(nothing changed there; these are for reading\):\n- Finding 3 — Clause 5: The quoted wording was not found/);
  assert.match(done, /Nothing needs placing/);
  const order = [...done.matchAll(/^Finding (\d+) — ([^(]+) \(/gm)].map((m) => [Number(m[1]), m[2].trim()]);
  assert.deepEqual(order, [[1, 'Clause 2'], [2, 'Clause 3'], [3, 'Clause 5'], [4, 'Governing law']]);
  assert.match(done, /Finding 1 — Clause 2 \(legal clauses and citations\) — Placed in v2 as a tracked change; decide it there\.\n {2}Original: shall not exceed the Contract Price\n {2}Suggested: shall not exceed the fees paid in the twelve months before the claim\n {2}Why: Market practice caps at fees paid\.\n {2}suggestionId: [0-9a-f-]{36}/);
  assert.match(done, /\[End of the findings\. They are filed in v2: decide them there\.\]/);
  resetReviewRuns();
});

test('get_review pages a long list of findings under the cap; a stopped or failed run says so; a bad id is one sentence', async () => {
  const s = setup();
  const runId = randomUUID();
  s.tables.ai_review_runs.push({ id: runId, document_version_id: V1, status: 'running', created_at: iso(CLOCK - 60_000) });
  const long = 'x'.repeat(3_000);
  complete(s.db, runId, Array.from({ length: 40 }, (_, i) => ({ clause_reference: `Clause ${i + 1}`, review_type: 'legal_clauses', original_text: `${long} ${i}`, suggested_text: `${long} new ${i}`, rationale: 'r' })));
  const first = await s.run(GET_TOOL, { runId });
  assert.ok(first.length <= MAX_RESULT_CHARS);
  const next = Number(/call get_review again with from: (\d+)/.exec(first)[1]);
  assert.ok(next > 1 && next <= 40);
  assert.match(first, /\(cut; |…/);
  const second = await s.run(GET_TOOL, { runId, from: next });
  assert.match(second, new RegExp(`^Finding ${next} — Clause ${next} `, 'm'));
  assert.ok(second.length <= MAX_RESULT_CHARS);

  // A connector run no process is running: the restart sentence, without waiting.
  const orphan = randomUUID();
  s.tables.ai_review_runs.push({ id: orphan, document_version_id: V1, status: 'running', created_at: iso(CLOCK - 60_000) });
  s.tables.connector_actions.push({ id: randomUUID(), user_id: USER, tool: START_TOOL, label: runLabel(orphan), outcome: 'done', created_at: iso(CLOCK - 60_000) });
  assert.match(await s.run(GET_TOOL, { runId: orphan }), new RegExp(`Status: stopped without finishing\\. ${RESTART_SENTENCE}`));
  const failed = randomUUID();
  s.tables.ai_review_runs.push({ id: failed, document_version_id: V1, status: 'failed', error: RESTART_SENTENCE, created_at: iso(CLOCK - 60_000) });
  assert.match(await s.run(GET_TOOL, { runId: failed }), new RegExp(`Status: failed\\. ${RESTART_SENTENCE}$`));
  await assert.rejects(s.run(GET_TOOL, { runId: 'nope' }), /runId must be a review's run id/);
  await assert.rejects(s.run(GET_TOOL, { runId: randomUUID() }), /There is no review with that run id/);
  resetReviewRuns();
});

// ---------------------------------------------------------------------------
// apply_review_to_version

async function completedRun(s) {
  const runId = randomUUID();
  s.tables.ai_review_runs.push({ id: runId, document_version_id: V1, status: 'running', created_at: iso(CLOCK - 600_000) });
  complete(s.db, runId);
  return runId;
}

test('apply files a review that was not filed: all but the excluded findings as tracked changes in the next version, the ones it could not place named, and where each went recorded', async () => {
  const s = setup();
  const runId = await completedRun(s);
  const out = await s.run(APPLY_TOOL, { runId, exclude: [2] });
  assert.match(out, /filed the result as v2 \(Supply-Agreement-v2\.docx\).*labelled "Review suggestions placed — 21 October 2026"/);
  assert.match(out, /Findings: 2 of 4 placed as tracked changes by AKLA AI; 1 left out at the lawyer's word \(2\); 1 could not be placed\./);
  assert.match(out, /- Finding 1 — Clause 2: shall not exceed the Contract Price/);
  assert.match(out, /- Finding 4 — Governing law: the laws of Pakistan/);
  assert.match(out, new RegExp(`Could not be placed \\(nothing changed there\\):\\n- Finding 3 — Clause 5: ${PLACEMENT_TEXT.not_found.replace(/[.()]/g, '\\$&')}`));
  assert.match(out, new RegExp(`versionId: ${NEW_V}\\nOpen in Hub: ${HUB}/`));
  assert.match(out, /2 changes are waiting in v2's Changes list/);
  assert.match(out, /Nothing was accepted/);

  // The new version: the lawyer's filing, with the label, and the file carries the tracked changes.
  const v2 = s.tables.document_versions.find((v) => v.id === NEW_V);
  assert.equal(v2.label, 'Review suggestions placed — 21 October 2026');
  assert.equal(v2.is_ai_generated, false);
  const stored = new TextDecoder().decode((await import('fflate')).unzipSync(s.db.files[`${BUCKET}/${v2.storage_path}`])['word/document.xml']);
  assert.match(stored, /<w:ins [^>]*w:author="AKLA AI"/);
  assert.match(stored, /Islamic Republic of/);
  assert.doesNotMatch(stored, /special/, 'the excluded finding is not in the file');

  // Its Changes list: one 'edit' row per placed finding, with the revision ids.
  const newRows = s.tables.redline_suggestions.filter((r) => r.document_version_id === NEW_V);
  assert.equal(newRows.length, 2);
  for (const r of newRows) {
    assert.equal(r.review_type, 'edit');
    assert.equal(r.artifact_id, null);
    assert.equal(r.review_run_id, null);
    assert.equal(r.status, 'pending');
    assert.ok(r.revision_ids.length > 0);
    assert.ok(r.revision_ids.every((id) => id > 9000), 'ids above the floor');
    assert.match(r.rationale, /^Review \(legal clauses and citations\): /);
  }
  // The review's own rows say where each went.
  const own = Object.fromEntries(s.tables.redline_suggestions.filter((r) => r.review_run_id === runId).map((r) => [r.clause_reference, r]));
  assert.equal(own['Clause 2'].placement, 'superseded');
  assert.ok(newRows.some((r) => r.id === own['Clause 2'].superseded_by));
  assert.match(own['Clause 2'].placement_reason, /Placed in v2/);
  assert.equal(own['Clause 3'].status, 'rejected');
  assert.equal(own['Clause 3'].decided_by, USER);
  assert.equal(own['Clause 5'].placement, 'unplaced');
  assert.equal(own['Clause 5'].placement_reason, 'not_found');

  const [rec] = actions(s, APPLY_TOOL);
  assert.equal(rec.outcome, 'saved');
  assert.equal(rec.version_id, NEW_V);
  assert.equal(s.caps.released, s.caps.checked);

  // get_review now says where they went; a second apply with nothing left out is refused (it is filed).
  assert.match(await s.run(GET_TOOL, { runId }), /Finding 1 — Clause 2 \(legal clauses and citations\) — Placed in v2/);
  await assert.rejects(s.run(APPLY_TOOL, { runId }), /This review is already filed as v2, with its findings waiting there/);
  resetReviewRuns();
});

test('apply takes suggestionIds too, and refuses an exclusion that is not a finding, with nothing saved', async () => {
  const s = setup();
  const runId = await completedRun(s);
  await assert.rejects(s.run(APPLY_TOOL, { runId, exclude: [9, 'abc'] }), /9, abc are not findings of this review \(it has 4, numbered 1–4\); nothing was placed/);
  assert.equal(s.tables.document_versions.length, 3, 'nothing saved');
  const id = orderFindings(s.tables.redline_suggestions)[0].id;
  const out = await s.run(APPLY_TOOL, { runId, exclude: [id, '4'] });
  assert.match(out, /Findings: 1 of 4 placed .* 2 left out at the lawyer's word \(1, 4\)/);
  resetReviewRuns();
});

test('apply refuses a review still running, a failed one, and a document with a newer version than the one reviewed', async () => {
  const s = setup();
  const runId = runIdOf(await s.run(START_TOOL, { versionId: V1 }));
  await assert.rejects(s.run(APPLY_TOOL, { runId }), /That review is still running \(started 45 s ago\), so nothing was placed/);
  s.runner.runs[0].finish();
  await settle(); await settle();
  const failed = randomUUID();
  s.tables.ai_review_runs.push({ id: failed, document_version_id: V1, status: 'failed', error: 'Source retrieval failed; the review cannot establish its evidence.', created_at: iso(CLOCK) });
  await assert.rejects(s.run(APPLY_TOOL, { runId: failed }), /That review failed \(Source retrieval failed.*\), so it has nothing to place/);

  const done = await completedRun(s);
  s.tables.document_versions.push({ id: randomUUID(), matter_document_id: D1, version_number: 2, storage_path: `${P1}/${D1}/v2.docx`, file_name: 'v2.docx', created_at: iso(CLOCK), matter_document: docJoin });
  await assert.rejects(s.run(APPLY_TOOL, { runId: done }), (err) => {
    assert.match(err.message, /A newer version of Supply Agreement exists \(v2, versionId [0-9a-f-]{36}\), so nothing was placed: the review's findings quote v1's words/);
    assert.match(err.message, new RegExp(`Open in Hub: ${HUB}/`));
    return true;
  });
  assert.deepEqual(actions(s, APPLY_TOOL).map((a) => a.outcome), ['refused', 'refused', 'refused']);
  assert.ok(!s.tables.document_versions.some((v) => v.id === NEW_V), 'nothing saved');
  resetReviewRuns();
});

test('apply with nothing placeable saves nothing and lists why', async () => {
  const s = setup();
  const runId = randomUUID();
  s.tables.ai_review_runs.push({ id: runId, document_version_id: V1, status: 'running', created_at: iso(CLOCK) });
  complete(s.db, runId, [FINDINGS[3]]);
  await assert.rejects(s.run(APPLY_TOOL, { runId }), new RegExp(`None of the 1 finding could be placed, so nothing was saved: Finding 1 — Clause 5: ${PLACEMENT_TEXT.not_found.replace(/[.()]/g, '\\$&')}`));
  assert.ok(!s.tables.document_versions.some((v) => v.id === NEW_V));
  resetReviewRuns();
});

test('with the MCP Apps trial on, apply answers its full text and the new version\'s cards for the changes panel', async () => {
  const s = setup({ apps: true });
  const runId = await completedRun(s);
  const out = await s.run(APPLY_TOOL, { runId, exclude: [2] });
  assert.equal(typeof out, 'object');
  assert.match(out.text, /Findings: 2 of 4 placed/);
  assert.match(out.text, new RegExp(`Open in Hub: ${HUB}/`));
  const panel = out.structuredContent;
  assert.equal(panel.kind, PANEL_KIND);
  assert.equal(panel.versionId, NEW_V);
  assert.equal(panel.versionNumber, 2);
  assert.equal(panel.canDecide, true);
  assert.equal(panel.changes.length, 2);
  assert.ok(panel.changes.every((c) => c.state === 'waiting' && c.canDecide));
  assert.equal(panel.counts.waiting, 2);
  // Off: text only.
  const t = setup({ apps: false });
  const plain = await t.run(APPLY_TOOL, { runId: await completedRun(t) });
  assert.equal(typeof plain, 'string');
  resetReviewRuns();
});

// ---------------------------------------------------------------------------
// Filing on its own

/** Waits (a little) for something the detached run does after it settles. */
async function until(cond, ms = 3_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const runRow = (s, id) => s.tables.ai_review_runs.find((r) => r.id === id);

test('a complete review files itself: the findings as tracked changes in the next version, one change row each, the reviewed rows saying where each went, on the record', async () => {
  const s = setup();
  const runId = runIdOf(await s.run(START_TOOL, { versionId: V1 }));
  complete(s.db, runId);
  s.runner.runs[0].finish();
  await until(() => filingOf(runRow(s, runId)));
  await until(() => activeReviewRuns().length === 0);

  const filing = filingOf(runRow(s, runId));
  assert.equal(filing.status, 'filed');
  assert.equal(filing.versionId, NEW_V);
  assert.equal(filing.versionNumber, 2);
  assert.equal(filing.placed, 3);
  assert.deepEqual(filing.notPlaced.map((x) => x.reason), ['not_found']);
  assert.equal(filing.reviewedVersionId, V1);
  assert.equal(filing.by, USER);
  // The coverage the review recorded is kept beside the filing.
  assert.equal(runRow(s, runId).coverage.documentCharacters, 4000);

  const v2 = s.tables.document_versions.find((v) => v.id === NEW_V);
  assert.equal(v2.label, 'Review suggestions placed — 21 October 2026');
  assert.equal(v2.is_ai_generated, true, 'filed automatically: an AI version until the lawyer decides it');
  assert.equal(v2.uploaded_by, USER);
  const stored = new TextDecoder().decode((await import('fflate')).unzipSync(s.db.files[`${BUCKET}/${v2.storage_path}`])['word/document.xml']);
  assert.match(stored, /<w:ins [^>]*w:author="AKLA AI"/);
  assert.match(stored, /special/);

  const newRows = s.tables.redline_suggestions.filter((r) => r.document_version_id === NEW_V);
  assert.equal(newRows.length, 3);
  assert.ok(newRows.every((r) => r.review_type === 'edit' && r.status === 'pending' && r.revision_ids.length > 0 && r.review_run_id === null));
  const own = s.tables.redline_suggestions.filter((r) => r.review_run_id === runId);
  assert.equal(own.filter((r) => r.placement === 'superseded').length, 3);
  assert.ok(own.filter((r) => r.placement === 'superseded').every((r) => newRows.some((n) => n.id === r.superseded_by)));
  assert.equal(own.find((r) => r.clause_reference === 'Clause 5').placement, 'unplaced');
  assert.ok(own.every((r) => r.status === 'pending'), 'nothing decided for the lawyer');

  const [rec] = actions(s, APPLY_TOOL);
  assert.equal(rec.outcome, 'saved');
  assert.equal(rec.version_id, NEW_V);
  assert.equal(rec.label, 'Review suggestions placed — 21 October 2026');
  resetReviewRuns();
});

test('with the MCP Apps trial on, get_review of a filed review carries the filed version\'s changes panel; while running, text only', async () => {
  const s = setup({ apps: true });
  const runId = runIdOf(await s.run(START_TOOL, { versionId: V1 }));
  assert.equal(s.tool(GET_TOOL).ui, CHANGES_UI);
  assert.equal(typeof (await s.run(GET_TOOL, { runId })), 'string', 'still running: no panel');
  complete(s.db, runId);
  s.runner.runs[0].finish();
  await until(() => filingOf(runRow(s, runId)));
  await until(() => activeReviewRuns().length === 0);
  const out = await s.run(GET_TOOL, { runId });
  assert.equal(typeof out, 'object');
  assert.match(out.text, /FILED: .* in v2/);
  assert.equal(out.structuredContent.kind, PANEL_KIND);
  assert.equal(out.structuredContent.versionId, NEW_V);
  assert.equal(out.structuredContent.changes.length, 3);
  assert.equal(out.structuredContent.counts.waiting, 3);
  assert.equal(out.structuredContent.canDecide, true);
  resetReviewRuns();
});

test('a version saved while the review ran: nothing is placed over it, and get_review says so plainly', async () => {
  const s = setup();
  const runId = runIdOf(await s.run(START_TOOL, { versionId: V1 }));
  const theirs = randomUUID();
  s.tables.document_versions.push({ id: theirs, matter_document_id: D1, version_number: 2, storage_path: `${P1}/${D1}/v2.docx`, file_name: 'Supply-Agreement-v2.docx', created_at: iso(CLOCK), matter_document: docJoin });
  complete(s.db, runId);
  s.runner.runs[0].finish();
  await until(() => filingOf(runRow(s, runId)));
  await until(() => activeReviewRuns().length === 0);
  const filing = filingOf(runRow(s, runId));
  assert.equal(filing.status, 'newer_version');
  assert.equal(filing.latestVersionId, theirs);
  assert.ok(!s.tables.document_versions.some((v) => v.id === NEW_V), 'nothing saved');
  assert.ok(s.tables.redline_suggestions.filter((r) => r.review_run_id === runId).every((r) => r.placement === 'placed' && r.status === 'pending'), 'the findings are as the review left them');
  assert.equal(actions(s, APPLY_TOOL)[0].outcome, 'refused');
  const read = await s.run(GET_TOOL, { runId });
  assert.match(read, new RegExp(`NOT FILED: v2 of "Supply Agreement" was saved while the review ran \\(versionId ${theirs}\\), and the findings quote v1's words, so nothing was placed over it`));
  assert.match(read, /\[End of the findings\.\]/);
  await assert.rejects(s.run(APPLY_TOOL, { runId }), /A newer version of Supply Agreement exists \(v2/);
  resetReviewRuns();
});

test('apply places a filed review again less the ones left out, as a fresh version; the filed version\'s changes from it stop waiting; refused once one is decided', async () => {
  const s = setup();
  const runId = runIdOf(await s.run(START_TOOL, { versionId: V1 }));
  complete(s.db, runId);
  s.runner.runs[0].finish();
  await until(() => filingOf(runRow(s, runId))?.status === 'filed');
  await until(() => activeReviewRuns().length === 0);
  const v2Rows = () => s.tables.redline_suggestions.filter((r) => r.document_version_id === NEW_V);

  const out = await s.run(APPLY_TOOL, { runId, exclude: [2] });
  assert.match(out, /Placed the review's findings again from "Supply Agreement" v1, less the ones left out, and filed the result as v3/);
  assert.match(out, /The review's changes in v2 no longer wait there/);
  assert.match(out, /Findings: 2 of 4 placed .* 1 left out at the lawyer's word \(2\); 1 could not be placed/);
  const v3 = s.tables.document_versions.find((v) => v.version_number === 3);
  assert.equal(v3.is_ai_generated, false, 'placed again at the lawyer\'s word: their filing');
  const v3Rows = s.tables.redline_suggestions.filter((r) => r.document_version_id === v3.id);
  assert.equal(v3Rows.length, 2);
  assert.ok(v2Rows().every((r) => r.placement === 'superseded'), 'nothing of this review waits in v2');
  assert.equal(v2Rows().filter((r) => /Placed again in v3/.test(r.placement_reason)).length, 2);
  assert.equal(v2Rows().filter((r) => /Left out when the review was placed again in v3/.test(r.placement_reason)).length, 1);
  const own = Object.fromEntries(s.tables.redline_suggestions.filter((r) => r.review_run_id === runId).map((r) => [r.clause_reference, r]));
  assert.equal(own['Clause 3'].status, 'rejected');
  assert.ok(v3Rows.some((r) => r.id === own['Clause 2'].superseded_by));
  assert.equal(filingOf(runRow(s, runId)).versionId, v3.id);
  assert.equal(filingOf(runRow(s, runId)).replacedVersionNumber, 2);
  assert.match(await s.run(GET_TOOL, { runId }), /FILED: .* in v3/);

  // Once a change in the filed version is decided, it is not placed again.
  const t = setup();
  const second = runIdOf(await t.run(START_TOOL, { versionId: V1 }));
  complete(t.db, second);
  t.runner.runs[0].finish();
  await until(() => filingOf(runRow(t, second))?.status === 'filed');
  await until(() => activeReviewRuns().length === 0);
  t.tables.redline_suggestions.find((r) => r.document_version_id === NEW_V).status = 'accepted';
  await assert.rejects(t.run(APPLY_TOOL, { runId: second, exclude: [1] }), /Changes in v2, where the review was filed, have already been decided/);
  assert.equal(t.tables.document_versions.length, 4, 'nothing saved');
  resetReviewRuns();
});

test('the filing: a stop asked for before the save files nothing; a follow-up\'s corrections go into a further version carrying what still waits', async () => {
  const s = setup();
  const runId = await completedRun(s);
  const save = (args) => s.db && createProjectWrites({ supabase: s.db, hubUrl: HUB, now: () => new Date(CLOCK) }).saveVersion({ ctx: { userId: USER }, ...args });
  const stopped = await fileReviewRun({ supabase: s.db, runId, userId: USER, save, shouldStop: () => true, now: () => new Date(CLOCK) });
  assert.equal(stopped.status, 'stopped');
  assert.equal(filingOf(runRow(s, runId)), null, 'nothing recorded: it can be filed later');
  assert.ok(!s.tables.document_versions.some((v) => v.id === NEW_V));

  const filed = await fileReviewRun({ supabase: s.db, runId, userId: USER, save, now: () => new Date(CLOCK) });
  assert.equal(filed.status, 'filed');
  assert.match(filingReplyText(filed, { title: 'Supply Agreement' }), /^Filed as v2 of "Supply Agreement": 3 changes are waiting for you in its Changes list, open beside this reply\. Accept or reject each there; nothing else needs doing\.\n\nCould not be placed \(1\):\n- Clause 5 — The quoted wording was not found/);

  // A follow-up correction, recorded against the version reviewed, as every finding is.
  s.tables.redline_suggestions.push({ id: randomUUID(), document_version_id: V1, review_run_id: runId, artifact_id: null, clause_reference: 'Heading', review_type: 'chat', original_text: 'LIMITATION OF LIABILITY', suggested_text: 'LIMITATION OF THE PARTIES’ LIABILITY', rationale: 'The term sheet names both parties.', status: 'pending', placement: null, created_at: iso(CLOCK) });
  const row = s.tables.redline_suggestions.at(-1);
  const more = await fileFollowUp({ supabase: s.db, runId, rows: [row], userId: USER, save, now: () => new Date(CLOCK) });
  assert.equal(more.status, 'filed');
  assert.equal(more.saved.versionNumber, 3);
  const v3Rows = s.tables.redline_suggestions.filter((r) => r.document_version_id === more.saved.versionId);
  assert.equal(v3Rows.length, 4, 'the three still waiting carried forward, and the correction');
  assert.ok(s.tables.redline_suggestions.filter((r) => r.document_version_id === NEW_V).every((r) => r.placement === 'superseded'));
  assert.equal(row.placement, 'superseded');
  const filing = filingOf(runRow(s, runId));
  assert.equal(filing.versionId, more.saved.versionId);
  assert.equal(filing.followUps, 1);
  assert.equal(filing.placed, 4);
  // After a follow-up, leaving findings out is done by rejecting them.
  const again = await fileReviewRun({ supabase: s.db, runId, userId: USER, save, exclude: [row.id], now: () => new Date(CLOCK) });
  assert.equal(again.status, 'decided_in_filed');
  resetReviewRuns();
});

// ---------------------------------------------------------------------------
// Stopping

test('on SIGTERM a running review is aborted and marked failed with the restart sentence, inside the window', async () => {
  const s = setup();
  const runId = runIdOf(await s.run(START_TOOL, { versionId: V1 }));
  const t0 = Date.now();
  const stopped = await stopReviewRuns({ supabase: s.db, waitMs: 2_500 });
  assert.equal(stopped, 1);
  assert.ok(Date.now() - t0 < 1_000, 'a run that honours its signal stops at once');
  const row = s.tables.ai_review_runs.find((r) => r.id === runId);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, RESTART_SENTENCE, 'the restart sentence, not the abort\'s own words');
  await settle();
  assert.deepEqual(activeReviewRuns(), []);
  assert.match(await s.run(GET_TOOL, { runId }), new RegExp(`Status: failed\\. ${RESTART_SENTENCE}`));
  resetReviewRuns();
});

test('a run that ignores its signal is still marked failed after the wait; a complete one is left complete; nothing running is a no-op', async () => {
  const s = setup({ runner: fakeRunner({ ignoreSignal: true }) });
  const runId = runIdOf(await s.run(START_TOOL, { versionId: V1 }));
  const t0 = Date.now();
  assert.equal(await stopReviewRuns({ supabase: s.db, waitMs: 50 }), 1);
  assert.ok(Date.now() - t0 < 1_000);
  assert.equal(s.tables.ai_review_runs.find((r) => r.id === runId).error, RESTART_SENTENCE);
  s.runner.runs[0].finish();
  await settle(); await settle();

  const t = setup({ runner: fakeRunner({ ignoreSignal: true }) });
  const done = runIdOf(await t.run(START_TOOL, { versionId: V1 }));
  complete(t.db, done);
  await stopReviewRuns({ supabase: t.db, waitMs: 20 });
  assert.equal(t.tables.ai_review_runs.find((r) => r.id === done).status, 'complete');
  t.runner.runs[0].finish();
  await settle(); await settle();
  assert.equal(await stopReviewRuns({ supabase: t.db }), 0);
  resetReviewRuns();
});

test('at startup, runs an earlier connector process left running are marked failed; the Hub chat\'s own are not touched', async () => {
  const s = setup();
  const orphan = randomUUID();
  const chat = randomUUID();
  s.tables.ai_review_runs.push({ id: orphan, document_version_id: V1, status: 'running', created_at: iso(CLOCK - 60_000) }, { id: chat, document_version_id: V1, status: 'running', created_at: iso(CLOCK - 60_000) });
  s.tables.connector_actions.push({ id: randomUUID(), user_id: USER, tool: START_TOOL, label: runLabel(orphan), outcome: 'done', created_at: iso(CLOCK - 60_000) });
  assert.equal(await failOrphanedRuns({ supabase: s.db, now: () => CLOCK }), 1);
  assert.equal(s.tables.ai_review_runs.find((r) => r.id === orphan).error, RESTART_SENTENCE);
  assert.equal(s.tables.ai_review_runs.find((r) => r.id === chat).status, 'running');
  // A sweep that cannot run never stops the start.
  assert.equal(await failOrphanedRuns({ supabase: { from: () => { throw new Error('down'); } } }), 0);
  resetReviewRuns();
});

test('connector.js stops reviews on SIGTERM before exiting, sweeps at startup, and reports running reviews on /health; deploy.sh warns', () => {
  const src = readFileSync(new URL('../connector/connector.js', import.meta.url), 'utf8');
  assert.match(src, /stopReviewRuns\(\{ supabase: db, log \}\)/);
  assert.match(src, /failOrphanedRuns\(\{ supabase: db, log \}\)/);
  assert.match(src, /setTimeout\(\(\) => process\.exit\(0\), 5_000\)/);
  assert.match(src, /reviewsRunning: activeReviewRuns\(\)\.length/);
  assert.match(src, /anthropicKey: ANTHROPIC_KEY/);
  assert.doesNotMatch(src, /ANTHROPIC_API_KEY[^\n]*process\.exit/, 'a missing AI key never stops the start');
  const deploy = readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');
  assert.ok(deploy.indexOf('reviewsRunning') < deploy.indexOf('sudo systemctl restart hub-connector'), 'the warning comes before the restart');
});

test('the Hub files its own reviews the same way: the Review button, the Hub chat\'s review of a project version and its legacy branch all go through reviewFiling.js as the lawyer', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /return await fileReviewRun\(\{ supabase: db, runId, userId, save: \(args\) => hubWrites\.saveVersion\(\{ ctx: \{ userId \}, \.\.\.args \}\)/);
  assert.match(src, /const filing = await fileHubReview\(result\.reviewRunId, user\.id\);[\s\S]{0,300}json\(200, \{ \.\.\.result, filed: filingSummary\(filing\) \}\);/);
  assert.equal([...src.matchAll(/await fileHubReview\(review\.reviewRunId, user\.id\)/g)].length, 2, 'the chat\'s version review and its legacy branch');
  assert.match(src, /const out = await fileFollowUp\(\{ supabase, runId: filedData\.reviewRunId/);
  assert.match(src, /REVIEW_FILES_TO_PROJECT = process\.env\.REVIEW_FILES_TO_PROJECT !== "0"/);
  const deploy = readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');
  assert.equal([...deploy.matchAll(/reviewFiling\.js/g)].length, 3, 'shipped, moved into place and owned like every root module');
});
