// search_everything (connector/tools/searchEverything.js): the Hub's project
// search for a lawyer's claude.ai, through search_project_content_as with
// the signed-in user's id. Against a stubbed database: the call the tool
// makes, how it prints documents, notes and tasks with their Hub links and
// pages, what it says when nothing matches, and the plain sentence it gives
// when the migration has not been applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES } from '../connector/tools.js';
import { DEFAULT_HUB_URL } from '../connector/hubLinks.js';
import searchEverything, { isMissingFunction, PAGE_SIZE, KINDS } from '../connector/tools/searchEverything.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const N1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const T1 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

// A client with the matters table (for needProject) and an rpc whose answer
// the test sets; every rpc call is kept for inspection.
function fakeSupabase({ matters = [], rpc = { data: [], error: null } } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => { calls.push({ name, args }); return typeof rpc === 'function' ? rpc(name, args) : rpc; },
    from: (table) => {
      let rows = table === 'matters' ? [...matters] : [];
      let single = false;
      const q = {
        select() { return q; },
        eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
        maybeSingle() { single = true; return q; },
        then(ok, bad) { return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(ok, bad); },
      };
      return q;
    },
  };
}

const row = (extra) => ({ kind: 'document', item_id: V1, matter_id: P1, matter_name: 'M6 Motorway', title: 'Concession Agreement', snippet: 'the Authority may exercise ⟦step-in⟧ ⟦rights⟧ under clause 31', document_id: 'doc', version_id: V1, version_number: 3, storage_path: 'p/ca-v3.docx', file_name: 'CA v3.docx', created_at: '2026-03-02T09:00:00Z', rank: 0.6, total_count: 3, matched_in: 'text', ...extra });
const NOTE = row({ kind: 'note', item_id: N1, matter_id: P2, matter_name: 'Old Port Deal', title: 'Project note', snippet: 'Client asked about ⟦step-in⟧ ⟦rights⟧ for lenders', document_id: null, version_id: null, version_number: null, storage_path: null, file_name: null, created_at: '2026-02-10T09:00:00Z', rank: 0.3 });
const TASK = row({ kind: 'task', item_id: T1, matter_id: P1, title: 'Draft step-in rights clause', snippet: 'Status: in progress · Due 2026-04-01', document_id: null, version_id: null, version_number: null, storage_path: null, file_name: null, created_at: '2026-02-20T09:00:00Z', rank: 0.2, matched_in: 'title' });

const matters = [{ id: P1, name: 'M6 Motorway', status: 'active' }, { id: P2, name: 'Old Port Deal', status: 'closed' }];
const make = (db, extra = {}) => createHubTools({ supabase: db, voyageKey: 'v', log: () => {}, modules: [searchEverything], ...extra });
const tool = (db, extra) => make(db, extra).find((t) => t.name === 'search_everything');

test('search_everything registers after the built-in eight, read-only in shape, and is in the real directory', async () => {
  const list = make(fakeSupabase());
  assert.deepEqual(list.slice(0, BUILT_IN_TOOL_NAMES.length).map((t) => t.name), [...BUILT_IN_TOOL_NAMES]);
  const t = list.find((x) => x.name === 'search_everything');
  assert.ok(t, 'registered');
  assert.match(t.title, /every project/);
  assert.match(t.description, /double quotes/i);
  assert.match(t.description, /read_document/);
  assert.ok(t.inputSchema.query && t.inputSchema.projectId && t.inputSchema.kind && t.inputSchema.allVersions && t.inputSchema.page);
  assert.deepEqual(KINDS, ['all', 'document', 'note', 'task']);
  assert.equal(PAGE_SIZE, 25);
  const real = await loadToolModules();
  assert.ok(real.some((m) => m.file === 'searchEverything.js'), 'loaded from connector/tools/');
});

test('the database is asked as the signed-in user, with the site\'s defaults and the page as an offset', async () => {
  const db = fakeSupabase({ matters, rpc: { data: [row()], error: null } });
  const t = tool(db);
  await t.run({ query: '  "step-in rights"  ' }, { userId: U1 });
  assert.deepEqual(db.calls[0], { name: 'search_project_content_as', args: { p_user_id: U1, p_query: '"step-in rights"', p_matter_id: null, p_kind: 'all', p_all_versions: false, p_limit: 25, p_offset: 0 } });
  await t.run({ query: 'step-in', projectId: P1, kind: 'note', allVersions: true, page: 3 }, { userId: U1 });
  assert.deepEqual(db.calls[1].args, { p_user_id: U1, p_query: 'step-in', p_matter_id: P1, p_kind: 'note', p_all_versions: true, p_limit: 25, p_offset: 50 });
  // A query longer than the function accepts is cut to its limit, not refused.
  await t.run({ query: 'x'.repeat(300) }, { userId: U1 });
  assert.equal(db.calls[2].args.p_query.length, 200);
});

test('input it refuses: no user, a short query, a projectId that is not a project', async () => {
  const db = fakeSupabase({ matters });
  const t = tool(db);
  await assert.rejects(t.run({ query: 'step-in rights' }, {}), /signed-in Hub user/);
  await assert.rejects(t.run({ query: 'step-in rights' }, { userId: 'not-a-uuid' }), /signed-in Hub user/);
  await assert.rejects(t.run({ query: ' x ' }, { userId: U1 }), /at least 2 characters/);
  await assert.rejects(t.run({}, { userId: U1 }), /at least 2 characters/);
  await assert.rejects(t.run({ query: 'step-in', projectId: 'nope' }, { userId: U1 }), /projectId must be a project id/);
  await assert.rejects(t.run({ query: 'step-in', projectId: V1 }, { userId: U1 }), /no project with that id/);
  assert.equal(db.calls.length, 0, 'nothing reached the database');
});

test('documents, notes and tasks are printed with their snippets, ids and Hub links', async () => {
  const db = fakeSupabase({ matters, rpc: { data: [row(), NOTE, TASK], error: null } });
  const text = await tool(db, { hubUrl: 'https://hub.test/' }).run({ query: '"step-in rights"' }, { userId: U1 });
  assert.match(text, /^3 results for “"step-in rights"” in every project's documents, notes and tasks\./);
  assert.match(text, /Only the current version of each document was searched; allVersions: true/);
  assert.match(text, /marked ⟦like this⟧/);
  assert.match(text, /1\. \[document\] Concession Agreement v3 \(CA v3\.docx\) — project M6 Motorway; saved 2 Mar 2026; matched in the text\n   the Authority may exercise ⟦step-in⟧ ⟦rights⟧ under clause 31\n   versionId: dddddddd-dddd-4ddd-8ddd-dddddddddddd\n   Open in Hub: https:\/\/hub\.test\/ai\/d\/dddddddd-dddd-4ddd-8ddd-dddddddddddd\?embed=1&host=pane/);
  assert.match(text, /2\. \[note\] Project note on Old Port Deal, 10 Feb 2026\n   Client asked about ⟦step-in⟧ ⟦rights⟧ for lenders\n   Open in Hub: https:\/\/hub\.test\/ai\/p\/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\?embed=1&host=pane/);
  assert.match(text, /3\. \[task\] Draft step-in rights clause — project M6 Motorway; Status: in progress · Due 2026-04-01; created 20 Feb 2026\n   Open in Hub: https:\/\/hub\.test\/ai\/p\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\?embed=1&host=pane/);
  assert.match(text, /\[End of results\.\]$/);
  assert.ok(!text.includes('page 1 of'), 'one page needs no page line');
  // The default site, a title match (no text snippet to show), and a scoped search.
  const db2 = fakeSupabase({ matters, rpc: { data: [row({ matched_in: 'title', snippet: '⟦CA⟧ v3.docx', total_count: 1 })], error: null } });
  const t2 = await tool(db2).run({ query: 'CA', projectId: P1, kind: 'document' }, { userId: U1 });
  assert.match(t2, /^1 result for “CA” in M6 Motorway's documents\./);
  assert.match(t2, /matched in the title or file name\n   versionId: /);
  assert.ok(!t2.includes('⟦CA⟧ v3.docx'), 'the file name is already in the line');
  assert.ok(t2.includes(`Open in Hub: ${DEFAULT_HUB_URL}/ai/d/${V1}?embed=1&host=pane`));
  // Notes and tasks have no versions, so no sentence about them.
  const t3 = await tool(fakeSupabase({ matters, rpc: { data: [NOTE], error: null } })).run({ query: 'step-in', kind: 'note' }, { userId: U1 });
  assert.match(t3, /in every project's notes\. The matched words/);
  assert.ok(!t3.includes('current version'));
});

test('pages: the head counts them and the tail says how to get the next', async () => {
  const rows = Array.from({ length: PAGE_SIZE }, (_, i) => row({ item_id: `item-${i}`, total_count: 61 }));
  const db = fakeSupabase({ matters, rpc: { data: rows, error: null } });
  const t = tool(db);
  const p1 = await t.run({ query: 'step-in' }, { userId: U1 });
  assert.match(p1, /^61 results for “step-in” in every project's documents, notes and tasks — page 1 of 3, results 1–25\./);
  assert.match(p1, /\n1\. \[document\]/);
  assert.match(p1, /\n25\. \[document\]/);
  assert.match(p1, /\[More results: call search_everything again with page: 2\.\]$/);
  const p3 = await t.run({ query: 'step-in', page: 3 }, { userId: U1 });
  assert.match(p3, /page 3 of 3, results 51–75\./);
  assert.match(p3, /\n51\. \[document\]/);
  assert.match(p3, /\[End of results\.\]$/);
  const empty = await tool(fakeSupabase({ matters, rpc: { data: [], error: null } })).run({ query: 'step-in', page: 4 }, { userId: U1 });
  assert.equal(empty, 'There is no page 4 of results for “step-in” in every project\'s documents, notes and tasks.');
});

test('nothing found says so and points at the search by meaning', async () => {
  const db = fakeSupabase({ matters, rpc: { data: [], error: null } });
  const text = await tool(db).run({ query: 'unobtainium', projectId: P1 }, { userId: U1 });
  assert.equal(text, 'Nothing in M6 Motorway\'s documents, notes and tasks contains “unobtainium”. Only the current version of each document was searched; allVersions: true searches the superseded ones too. The search matches words, not meaning: try fewer or other words, or search_project_documents for passages on the point in one project.');
  const all = await tool(db).run({ query: 'unobtainium', allVersions: true }, { userId: U1 });
  assert.match(all, /^Nothing in every project's documents, notes and tasks contains “unobtainium”\. Every version of each document was searched\./);
});

test('a database without the migration, a refused user and any other failure each get a plain sentence', async () => {
  const missing = { code: 'PGRST202', message: 'Could not find the function public.search_project_content_as(p_all_versions, p_kind, p_limit, p_matter_id, p_offset, p_query, p_user_id) in the schema cache' };
  await assert.rejects(tool(fakeSupabase({ matters, rpc: { data: null, error: missing } })).run({ query: 'step-in' }, { userId: U1 }), /does not have the project search for the connector yet \(search_project_content_as\)\. Apply supabase\/migrations\/20261020100000_search_project_content_as\.sql/);
  assert.ok(isMissingFunction({ code: '42883', message: 'function public.search_project_content_as(uuid, text) does not exist' }));
  assert.ok(isMissingFunction({ message: 'Could not find the function public.search_project_content_as in the schema cache' }));
  assert.ok(!isMissingFunction({ code: 'P0001', message: 'Forbidden' }));
  assert.ok(!isMissingFunction(null));
  await assert.rejects(tool(fakeSupabase({ matters, rpc: { data: null, error: { code: 'P0001', message: 'Forbidden' } } })).run({ query: 'step-in' }, { userId: U1 }), /does not have you as an approved member of the firm/);
  await assert.rejects(tool(fakeSupabase({ matters, rpc: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } })).run({ query: 'step-in' }, { userId: U1 }), /Could not search the projects: canceling statement due to statement timeout/);
});

test('the migration defines search_project_content_as for service_role only and turns the site\'s function into a wrapper', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261020100000_search_project_content_as.sql', import.meta.url), 'utf8');
  const original = readFileSync(new URL('../../supabase/migrations/20260918090200_project_search.sql', import.meta.url), 'utf8');
  assert.match(sql, /create or replace function public\.search_project_content_as\(p_user_id uuid, p_query text, p_matter_id uuid default null, p_kind text default 'all', p_all_versions boolean default false, p_limit integer default 25, p_offset integer default 0\)/);
  assert.match(sql, /language plpgsql stable security definer set search_path=public/);
  assert.match(sql, /if p_user_id is null or not public\.is_firm_member\(p_user_id\) then raise exception 'Forbidden'; end if;/);
  assert.match(sql, /revoke all on function public\.search_project_content_as\(uuid,text,uuid,text,boolean,integer,integer\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.search_project_content_as\(uuid,text,uuid,text,boolean,integer,integer\) to service_role;/);
  assert.match(sql, /select \* from public\.search_project_content_as\(auth\.uid\(\), p_query, p_matter_id, p_kind, p_all_versions, p_limit, p_offset\);/);
  assert.match(sql, /grant execute on function public\.search_project_content\(text,uuid,text,boolean,integer,integer\) to authenticated;/);
  assert.ok(!/auth\.uid\(\)\)/.test(sql.split('-- The site\'s function')[0]), 'the _as body reads p_user_id, never the session');
  // The search body itself is the original's, line for line, from the query check to the limit.
  const body = (s) => { const start = s.indexOf("  if length(trim(p_query))<2"); return s.slice(start, s.indexOf('end;\n$$;', start) + 'end;\n$$;'.length); };
  assert.equal(body(sql), body(original));
});
