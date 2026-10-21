// Piece 1.4 of the connector: get_project_overview and find_document_by_title
// (connector/tools/projects.js), and list_projects putting the lawyer's
// starred projects first (connector/tools.js). Against a stubbed database:
// the overview gathers the matter, its standing instructions, its relevant
// laws and each document's latest index card in pages; the title search is
// the site's ⌘K "contains" match; a missing matter_stars table means no
// stars; every project and version carries its Hub link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES, MAX_RESULT_CHARS, MAX_DOCUMENTS } from '../connector/tools.js';
import projects, { likePattern, latestVersion, OVERVIEW_PAGE, OVERVIEW_BUDGET, FIND_LIMIT, CONTEXT_CHARS } from '../connector/tools/projects.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P3 = '99999999-9999-4999-8999-999999999999';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02';
const D3 = 'dddddddd-dddd-4ddd-8ddd-dddddddddd03';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const V2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const V3 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const HUB = 'https://akla-interface.vercel.app';

/** An ilike pattern as a regular expression: % and _ are wildcards unless escaped. */
function likeRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) { re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; } else if (c === '%') re += '[\\s\\S]*';
    else if (c === '_') re += '[\\s\\S]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

// A Supabase client over plain arrays: eq/in/ilike/order/limit apply to the
// table's rows; nested selects are already on the rows; a table in `errors`
// answers with that error instead. `ins` records every `in` filter, so a
// test can see which rows' cards were asked for.
function fakeSupabase({ tables = {}, errors = {} } = {}) {
  const calls = [];
  const ins = [];
  const chain = (table) => {
    let rows = [...(tables[table] ?? [])];
    let single = false;
    const q = {
      select() { return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      in(col, vals) { ins.push({ table, col, vals: [...vals] }); rows = rows.filter((r) => vals.includes(r[col])); return q; },
      ilike(col, pattern) { const re = likeRegex(pattern); rows = rows.filter((r) => re.test(String(r[col] ?? ''))); return q; },
      order(col, { ascending = true } = {}) { rows.sort((a, b) => ((a[col] ?? 0) > (b[col] ?? 0) ? 1 : (a[col] ?? 0) < (b[col] ?? 0) ? -1 : 0) * (ascending ? 1 : -1)); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      maybeSingle() { single = true; return q; },
      then(ok, bad) { return Promise.resolve(errors[table] ? { data: null, error: errors[table] } : { data: single ? rows[0] ?? null : rows, error: null }).then(ok, bad); },
    };
    return q;
  };
  return { calls, ins, from: (table) => { calls.push(table); return chain(table); } };
}

const matter = (id, name, status, extra = {}) => ({ id, name, status, sector: 'Infrastructure', matter_type: 'PPP', opened_date: '2026-01-15', client: { name: 'NHA' }, ...extra });

function fixtures() {
  const card1 = { summary: 'A concession agreement between NHA and the Concessionaire for the M6.', parties: [{ name: 'NHA', role: 'Authority' }, { name: 'M6 Co', role: 'Concessionaire' }], key_dates: [{ date: '2026-12-01', what: 'Financial Close' }], defined_terms: ['Concession Period'], clause_outline: ['1. Definitions'], statutes_mentioned: ['National Highway Authority Act, 1991'] };
  const card2 = { summary: 'The draft concession agreement with the tolling clause added.', parties: [{ name: 'NHA' }], key_dates: [{ date: '2027-01-01' }], statutes_mentioned: [] };
  return {
    matters: [matter(P1, 'M6 Motorway', 'active'), matter(P2, 'Old Port Deal', 'closed'), matter(P3, 'Karachi Port Corridor', 'active', { client: { name: 'KPT' }, sector: 'Ports' })],
    matter_context: [{ matter_id: P1, content: 'The client wants a 30-year term. Use the 2024 NHA model agreement.', updated_at: '2026-10-05T08:00:00Z' }],
    matter_relevant_laws: [
      { matter_id: P1, act_name: 'National Highway Authority Act, 1991', status: 'available' },
      { matter_id: P1, act_name: 'Sindh Public Private Partnership Act, 2010', status: 'needs_upload' },
    ],
    matter_stars: [{ user_id: U1, matter_id: P3 }],
    matter_documents: [
      { id: D1, matter_id: P1, title: 'Concession Agreement', status: 'in_progress', matter: { id: P1, name: 'M6 Motorway' }, document_type: { name: 'Concession Agreement' }, versions: [
        { id: V1, version_number: 1, file_name: 'CA v1.docx', is_ai_generated: false, created_at: '2026-10-01T08:00:00Z', indexing_status: 'indexed', label: null, card: card1 },
        { id: V2, version_number: 2, file_name: 'CA v2.docx', is_ai_generated: true, created_at: '2026-10-05T08:00:00Z', indexing_status: 'indexed', label: 'AI draft', card: card2 },
      ] },
      { id: D2, matter_id: P1, title: 'Term Sheet', status: 'draft', matter: { id: P1, name: 'M6 Motorway' }, document_type: null, versions: [] },
      { id: D3, matter_id: P1, title: 'Notes 100% final_v2', status: null, matter: { id: P1, name: 'M6 Motorway' }, document_type: null, versions: [
        { id: V3, version_number: 1, file_name: 'notes.txt', is_ai_generated: false, created_at: '2026-10-06T08:00:00Z', indexing_status: 'pending', label: null, card: null },
      ] },
      { id: 'd4', matter_id: P3, title: 'Port Term Sheet', status: 'draft', matter: { id: P3, name: 'Karachi Port Corridor' }, document_type: { name: 'Term Sheet' }, versions: [
        { id: 'v4', version_number: 1, file_name: 'TS.docx', is_ai_generated: false, created_at: '2026-10-07T08:00:00Z', indexing_status: 'indexed', label: null, card: null },
      ] },
    ],
  };
}

function tools({ tables = fixtures(), errors = {}, userId = U1, ...extra } = {}) {
  // The versions are rows of document_versions too, for the card fetch.
  tables.document_versions ??= tables.matter_documents.flatMap((d) => d.versions);
  const supabase = fakeSupabase({ tables, errors });
  const list = createHubTools({ supabase, voyageKey: 'v', anthropicJson: null, library: {}, readFile: async () => ({ blocks: [] }), log: () => {}, modules: [projects], ...extra });
  const byName = Object.fromEntries(list.map((t) => [t.name, t]));
  return { supabase, list, byName, run: (name, input) => byName[name].run(input, { userId }) };
}

test('the module adds its two tools after the built-in eight, described and schema\'d for claude.ai', async () => {
  const { list } = tools();
  assert.deepEqual(list.map((t) => t.name), [...BUILT_IN_TOOL_NAMES, 'get_project_overview', 'find_document_by_title']);
  for (const t of list.slice(BUILT_IN_TOOL_NAMES.length)) {
    assert.ok(t.title, `${t.name} has a title`);
    assert.ok(t.description.length > 80, `${t.name} describes itself`);
    assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name} has an input schema`);
  }
  assert.ok(list.find((t) => t.name === 'get_project_overview').inputSchema.projectId);
  assert.ok(list.find((t) => t.name === 'find_document_by_title').inputSchema.query);
  // The real directory loads it too, under its file name.
  const modules = await loadToolModules();
  assert.ok(modules.some((m) => m.file === 'projects.js'));
});

test('get_project_overview gathers the project, its instructions, its laws and every document\'s latest card', async () => {
  const { run, supabase } = tools();
  const out = await run('get_project_overview', { projectId: P1 });
  assert.match(out, /^M6 Motorway — NHA; Infrastructure; PPP\nprojectId: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nOpen in Hub: https:\/\/akla-interface\.vercel\.app\/ai\/p\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\?embed=1&host=pane\n/);
  assert.doesNotMatch(out, /starred by you/);
  assert.match(out, /\nSTANDING INSTRUCTIONS\n\(the project's context on the Hub, updated 5 Oct 2026; follow it in anything you draft or answer for this project\)\nThe client wants a 30-year term\. Use the 2024 NHA model agreement\.\n/);
  assert.match(out, /\nRELEVANT LAWS \(2\)\n- National Highway Authority Act, 1991 \(in the law library: search_law_library and read_act_section read it\)\n- Sindh Public Private Partnership Act, 2010 \(not in the law library yet\)\n/);
  assert.match(out, /\nDOCUMENTS \(3\)\n/);
  // The newest version, its card, and the Hub link; the older version's card is not shown.
  assert.match(out, /- Concession Agreement \(Concession Agreement\) — in progress; 2 versions, latest v2 CA v2\.docx, saved 5 Oct 2026 \[AI draft, read by the Hub\]\n {2}versionId: eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\n {2}Open in Hub: https:\/\/akla-interface\.vercel\.app\/ai\/d\/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\?embed=1&host=pane\n {2}Summary: The draft concession agreement with the tolling clause added\.\n {2}Parties: NHA\n {2}Key dates: 2027-01-01\n/);
  assert.doesNotMatch(out, /Financial Close/);
  assert.doesNotMatch(out, /Defined terms|Clause outline/);
  assert.match(out, /- Notes 100% final_v2; 1 version, latest v1 notes\.txt, saved 6 Oct 2026 \[being read\]\n {2}versionId: ffffffff-ffff-4fff-8fff-ffffffffffff\n {2}Open in Hub: [^\n]+\/ai\/d\/ffffffff-ffff-4fff-8fff-ffffffffffff\?embed=1&host=pane\n {2}Index card: not written yet \(the Hub has not read this file\)\.\n/);
  assert.match(out, /- Term Sheet — draft; no versions saved$/);
  assert.doesNotMatch(out, /Showing documents|more document/);
  assert.deepEqual(supabase.calls, ['matters', 'matter_stars', 'matter_context', 'matter_relevant_laws', 'matter_documents', 'document_versions']);
  // The cards are fetched for the latest version of each document shown, never the older ones.
  assert.deepEqual(supabase.ins, [{ table: 'document_versions', col: 'id', vals: [V2, V3] }]);
  assert.ok(out.length <= MAX_RESULT_CHARS);
  // A project with no versions asks for no cards.
  const { run: run2, supabase: db2 } = tools();
  await run2('get_project_overview', { projectId: P2 });
  assert.deepEqual(db2.ins, []);
  assert.doesNotMatch(db2.calls.join(), /document_versions/);
});

test('get_project_overview reports a failure to read the cards', async () => {
  const { run } = tools({ errors: { document_versions: { message: 'canceling statement due to statement timeout' } } });
  await assert.rejects(run('get_project_overview', { projectId: P1 }), /Could not read the documents' index cards: canceling statement/);
});

test('get_project_overview says when a project is starred, has no instructions, laws or documents, or does not exist', async () => {
  const { run } = tools();
  const out = await run('get_project_overview', { projectId: P3 });
  assert.match(out, /^Karachi Port Corridor — KPT; Ports; PPP; starred by you\n/);
  assert.match(out, /\nSTANDING INSTRUCTIONS\nNone written on the Hub yet\.\n/);
  assert.match(out, /\nRELEVANT LAWS \(0\)\nNone marked on the Hub\. search_law_library searches every Act the firm holds\.\n/);
  assert.match(out, /- Port Term Sheet \(Term Sheet\) — draft; 1 version, latest v1 TS\.docx, saved 7 Oct 2026 \[read by the Hub\]\n {2}versionId: v4\n {2}Open in Hub: [^\n]+\/ai\/d\/v4\?embed=1&host=pane\n {2}Index card: not written\.$/);
  const empty = await run('get_project_overview', { projectId: P2 });
  assert.match(empty, /^Old Port Deal — NHA; Infrastructure; PPP; closed\n/);
  assert.match(empty, /\nDOCUMENTS \(0\)\nOld Port Deal has no documents yet\.$/);
  await assert.rejects(run('get_project_overview', { projectId: 'not-a-uuid' }), /projectId must be a project id/);
  await assert.rejects(run('get_project_overview', { projectId: '12121212-1212-4121-8121-121212121212' }), /There is no project with that id/);
});

/** A project of `n` documents, each with one indexed version carrying a card with a summary of `summaryChars`. */
function manyDocuments(n, summaryChars) {
  return Array.from({ length: n }, (_, i) => ({
    id: `doc${i}`, matter_id: P1, title: `Document ${String(i).padStart(3, '0')}`, status: 'draft', document_type: null,
    versions: [{ id: `ver${i}`, version_number: 1, file_name: `d${i}.docx`, is_ai_generated: false, created_at: '2026-10-01T08:00:00Z', indexing_status: 'indexed', label: null, card: { summary: 'x'.repeat(summaryChars), parties: [], key_dates: [], statutes_mentioned: ['Act A'] } }],
  }));
}

test('get_project_overview pages a long project\'s documents and clips long instructions', async () => {
  const tables = fixtures();
  tables.matter_documents = manyDocuments(OVERVIEW_PAGE + 5, 100);
  tables.matter_context = [{ matter_id: P1, content: 'y'.repeat(CONTEXT_CHARS + 50), updated_at: null }];
  const { run, supabase } = tools({ tables });
  const first = await run('get_project_overview', { projectId: P1 });
  assert.match(first, /\(the project's context on the Hub; follow it/);
  // Only the page's cards are fetched: OVERVIEW_PAGE ids on page 1, the five left on page 2.
  assert.deepEqual(supabase.ins.at(-1).vals, Array.from({ length: OVERVIEW_PAGE }, (_, i) => `ver${i}`));
  assert.match(first, new RegExp(`y{${CONTEXT_CHARS}}\\n\\[The instructions continue on the project page; only their first 8,000 characters are shown\\.\\]`));
  assert.match(first, new RegExp(`\\nDOCUMENTS \\(${OVERVIEW_PAGE + 5}\\)\\nShowing documents 1–${OVERVIEW_PAGE} of ${OVERVIEW_PAGE + 5}\\.\\n- Document 000`));
  assert.match(first, /Summary: x{100}\n {2}Statutes mentioned: Act A\n/);
  assert.doesNotMatch(first, new RegExp(`- Document ${String(OVERVIEW_PAGE).padStart(3, '0')}`));
  assert.match(first, new RegExp(`\\[5 more documents: call get_project_overview again with from: ${OVERVIEW_PAGE}\\.\\]$`));
  assert.ok(first.length <= MAX_RESULT_CHARS);
  assert.doesNotMatch(first, /\[Cut here:/);
  const second = await run('get_project_overview', { projectId: P1, from: OVERVIEW_PAGE });
  assert.match(second, new RegExp(`Showing documents ${OVERVIEW_PAGE + 1}–${OVERVIEW_PAGE + 5} of ${OVERVIEW_PAGE + 5}\\.\\n- Document ${String(OVERVIEW_PAGE).padStart(3, '0')}`));
  assert.doesNotMatch(second, /more document/);
  assert.deepEqual(supabase.ins.at(-1).vals, Array.from({ length: 5 }, (_, i) => `ver${OVERVIEW_PAGE + i}`));
  const beyond = await run('get_project_overview', { projectId: P1, from: 500 });
  assert.match(beyond, new RegExp(`There are ${OVERVIEW_PAGE + 5} documents; there is nothing at 500\\.$`));
  assert.ok(MAX_DOCUMENTS > OVERVIEW_PAGE);
});

test('get_project_overview shows fewer documents a page when their cards are long, and is never cut by the wrapper', async () => {
  const tables = fixtures();
  tables.matter_documents = manyDocuments(OVERVIEW_PAGE + 5, 2000);
  tables.matter_context = [{ matter_id: P1, content: 'y'.repeat(CONTEXT_CHARS + 50), updated_at: null }];
  const { run } = tools({ tables });
  const first = await run('get_project_overview', { projectId: P1 });
  assert.match(first, /Summary: x{599}…\n/);
  const shown = Number(first.match(/Showing documents 1–(\d+) of 35\./)[1]);
  assert.ok(shown > 0 && shown < OVERVIEW_PAGE, `a short page of ${shown}`);
  assert.equal((first.match(/versionId:/g) ?? []).length, shown);
  assert.ok(first.length <= OVERVIEW_BUDGET + 200, `${first.length} chars stays near the budget`);
  assert.doesNotMatch(first, /\[Cut here:/);
  assert.match(first, new RegExp(`\\[${35 - shown} more documents: call get_project_overview again with from: ${shown}\\.\\]$`));
  // The next page picks up exactly where this one stopped.
  const second = await run('get_project_overview', { projectId: P1, from: shown });
  assert.match(second, new RegExp(`Showing documents ${shown + 1}–\\d+ of 35\\.\\n- Document ${String(shown).padStart(3, '0')}`));
});

test('find_document_by_title matches titles and project names across the Hub, or within one project', async () => {
  const { run, supabase } = tools();
  const all = await run('find_document_by_title', { query: 'term sheet' });
  assert.match(all, /^2 documents whose title contains “term sheet” on the Hub:\n\n/);
  assert.match(all, /- Port Term Sheet \(Term Sheet\) — draft; project Karachi Port Corridor\n {2}projectId: 99999999-9999-4999-8999-999999999999\n {2}documentId: d4\n {2}latest v1 TS\.docx of 1 \[read by the Hub\]\n {2}versionId: v4\n {2}Open in Hub: https:\/\/akla-interface\.vercel\.app\/ai\/d\/v4\?embed=1&host=pane\n/);
  assert.match(all, /- Term Sheet — draft; project M6 Motorway\n {2}projectId: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n {2}documentId: dddddddd-dddd-4ddd-8ddd-dddddddddd02\n {2}no versions saved\n {2}Open in Hub: https:\/\/akla-interface\.vercel\.app\/ai\/p\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\?embed=1&host=pane/);
  assert.doesNotMatch(all, /Projects? whose name contains/);
  assert.deepEqual(supabase.calls, ['matter_documents', 'matters']);

  // A project name matches too, under its own heading; a document's latest version wins.
  const port = await run('find_document_by_title', { query: 'PORT' });
  assert.match(port, /^1 document whose title contains “PORT” on the Hub:\n\n- Port Term Sheet/);
  assert.match(port, /\n\nProjects whose name contains “PORT”:\n\n- Karachi Port Corridor — KPT; Ports; PPP\n {2}projectId: 99999999-9999-4999-8999-999999999999\n {2}Open in Hub: [^\n]+\/ai\/p\/99999999-9999-4999-8999-999999999999\?embed=1&host=pane\n- Old Port Deal — NHA; Infrastructure; PPP; closed\n {2}projectId: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
  const ca = await run('find_document_by_title', { query: 'concession' });
  assert.match(ca, /- Concession Agreement \(Concession Agreement\) — in progress; project M6 Motorway\n {2}projectId: [^\n]+\n {2}documentId: cccccccc-cccc-4ccc-8ccc-cccccccccccc\n {2}latest v2 CA v2\.docx of 2 \[AI draft, read by the Hub\]\n {2}versionId: eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/);

  // Within a project: only its documents, and project names are not searched.
  const { run: run2, supabase: db2 } = tools();
  const inM6 = await run2('find_document_by_title', { query: 'term sheet', projectId: P1 });
  assert.match(inM6, /^1 document whose title contains “term sheet” in M6 Motorway:\n\n- Term Sheet — draft; project M6 Motorway/);
  assert.doesNotMatch(inM6, /Port Term Sheet|whose name contains/);
  assert.deepEqual(db2.calls, ['matters', 'matter_documents']);
  await assert.rejects(run('find_document_by_title', { query: 'x', projectId: 'nope' }), /projectId must be a project id/);
});

test('find_document_by_title escapes the wildcards, says when nothing matches, and needs some words', async () => {
  const { run } = tools();
  const pct = await run('find_document_by_title', { query: '100% final_v2' });
  assert.match(pct, /^1 document whose title contains “100% final_v2” on the Hub:\n\n- Notes 100% final_v2; project M6 Motorway/);
  assert.equal(await run('find_document_by_title', { query: '100_ final' }), 'No document or project title contains “100_ final” on the Hub. Try fewer or other words; search_project_documents looks inside a project\'s documents.');
  assert.equal(await run('find_document_by_title', { query: 'tolling', projectId: P1 }), 'No document title contains “tolling” in M6 Motorway. Try fewer or other words; search_project_documents looks inside a project\'s documents.');
  await assert.rejects(run('find_document_by_title', { query: '   ' }), /Some words from the title are needed/);
  await assert.rejects(run('find_document_by_title', {}), /Some words from the title are needed/);
  assert.equal(likePattern(' a%b_c\\d '), '%a\\%b\\_c\\\\d%');
  // A * cannot reach Postgres as itself (PostgREST turns it into %), so it stands for one character rather than any run of them.
  assert.equal(likePattern('term*sheet'), '%term_sheet%');
  assert.match(await run('find_document_by_title', { query: 'final*v2' }), /^1 document whose title contains “final\*v2” on the Hub:\n\n- Notes 100% final_v2/);
  assert.match(await run('find_document_by_title', { query: '100*final' }), /^No document or project title contains “100\*final” on the Hub\./, 'two characters sit between 100 and final');
  assert.match(await run('find_document_by_title', { query: '*' }), /^4 documents whose title contains “\*” on the Hub/, 'a lone * is one character of a title (the fake treats _ as Postgres does)');
  assert.equal(latestVersion([{ id: 'a', version_number: 1 }, { id: 'c', version_number: 3 }, { id: 'b', version_number: 2 }]).id, 'c');
  assert.equal(latestVersion([]), null);
  assert.equal(latestVersion(null), null);
});

test('find_document_by_title says when it hit its limit', async () => {
  const tables = fixtures();
  tables.matter_documents = Array.from({ length: FIND_LIMIT + 3 }, (_, i) => ({ id: `doc${i}`, matter_id: P1, title: `Annex ${i}`, status: null, matter: { id: P1, name: 'M6 Motorway' }, document_type: null, versions: [] }));
  const { run } = tools({ tables });
  const out = await run('find_document_by_title', { query: 'annex', projectId: P1 });
  assert.match(out, new RegExp(`^The first ${FIND_LIMIT} documents whose title contains “annex” in M6 Motorway \\(there may be more: give more words\\):`));
  assert.equal((out.match(/documentId:/g) ?? []).length, FIND_LIMIT);
});

test('list_projects puts the lawyer\'s starred projects first and says so', async () => {
  const { run, supabase } = tools();
  const open = await run('list_projects', {});
  assert.match(open, /^2 open projects on the Hub \(1 closed not shown; includeClosed: true lists them\):\n\n- Karachi Port Corridor — starred; KPT; Ports; PPP; opened 15 Jan 2026\n {2}projectId: 99999999-9999-4999-8999-999999999999\n {2}Open in Hub: [^\n]+\n- M6 Motorway — NHA; Infrastructure; PPP; opened 15 Jan 2026\n/);
  assert.deepEqual(supabase.calls, ['matters', 'matter_stars']);
  // Another lawyer's star is not this lawyer's.
  const other = await tools({ userId: '22222222-2222-4222-8222-222222222222' }).run('list_projects', {});
  assert.match(other, /:\n\n- Karachi Port Corridor — KPT; Ports; PPP;/);
  assert.doesNotMatch(other, /starred/);
  // Closed projects keep their place behind the starred ones, in name order.
  const tables = fixtures();
  tables.matter_stars = [{ user_id: U1, matter_id: P2 }, { user_id: U1, matter_id: P3 }];
  const all = await tools({ tables }).run('list_projects', { includeClosed: true });
  assert.match(all, /^3 projects on the Hub:\n\n- Karachi Port Corridor — starred; KPT[^\n]*\n[^\n]*\n[^\n]*\n- Old Port Deal — starred; NHA; Infrastructure; PPP; closed[^\n]*\n[^\n]*\n[^\n]*\n- M6 Motorway — NHA/);
});

test('a missing matter_stars table means no stars; any other failure to read them is reported', async () => {
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.matter_stars' in the schema cache" };
  const { run } = tools({ errors: { matter_stars: missing } });
  const open = await run('list_projects', {});
  assert.match(open, /^2 open projects on the Hub/);
  assert.doesNotMatch(open, /starred/);
  assert.match(await run('get_project_overview', { projectId: P3 }), /^Karachi Port Corridor — KPT; Ports; PPP\n/);
  const broken = tools({ errors: { matter_stars: { code: '57014', message: 'canceling statement due to statement timeout' } } });
  await assert.rejects(broken.run('list_projects', {}), /Could not read your starred projects: canceling statement/);
  await assert.rejects(broken.run('get_project_overview', { projectId: P3 }), /Could not read the starred projects: canceling statement/);
  // No signed-in user (a test harness without one): the stars are not asked for.
  const anon = tools({ userId: null });
  assert.match(await anon.run('list_projects', {}), /^2 open projects on the Hub/);
  assert.deepEqual(anon.supabase.calls, ['matters']);
});
