// Search SharePoint (sharepointGraph.js, sharepointSearch.js), without the
// network: how a search is worded and held to the Data Room, what counts as
// a file of it, finding the tenant's region, the "not approved yet" answer,
// and the model's loop of searching, reading and reporting. Microsoft Graph,
// the model and the file reader are all stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sharePointEnv, createSharePoint, buildQuery, hitToFile, cleanSummary, regionFromError, plainUrl, linkUrl, SharePointError,
} from '../sharepointGraph.js';
import { findSharePointFiles, plainText, passagesAround, LIMITS } from '../sharepointSearch.js';

const ROOM_URL = 'https://aklacopk.sharepoint.com/sites/akla-internal/Shared Documents/AKLA - Data Room';
const room = { driveId: 'drive1', url: ROOM_URL };
const ENV = { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' };

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const hit = (id, path, extra = {}) => ({
  hitId: id,
  summary: extra.summary ?? '',
  resource: { id, name: path.split('/').pop(), webUrl: `${ROOM_URL}/${path}`.replace(/ /g, '%20'), lastModifiedDateTime: '2026-01-24T11:47:00Z', size: 84_000, parentReference: { driveId: 'drive1' }, ...extra.resource },
});

// Microsoft Graph: sign-in, the site, its drives and the Data Room folder
// answer as the real ones do; `search` decides what /search/query says.
function fakeGraph(search) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body && init.headers?.['Content-Type'] === 'application/json' ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    if (url.includes('login.microsoftonline.com')) return json({ access_token: 'tok', expires_in: 3600 });
    if (url.endsWith('/sites/aklacopk.sharepoint.com:/sites/akla-internal')) return json({ id: 'site1', siteCollection: {} });
    if (url.endsWith('/sites/site1/drives')) return json({ value: [{ id: 'other' }, { id: 'drive1' }] });
    if (url.includes('/drives/other/root:/')) return json({ error: { message: 'itemNotFound' } }, 404);
    if (url.includes('/drives/drive1/root:/')) return json({ id: 'room', webUrl: ROOM_URL.replace(/ /g, '%20') });
    if (url.endsWith('/search/query')) return search(body.requests[0]);
    if (url.endsWith('/content')) return new Response(new Uint8Array([1, 2, 3]));
    return json({ error: { message: `unexpected ${url}` } }, 500);
  };
  return { fetchImpl, calls };
}

// ------------------------------------------------------------ the settings

test('the app settings come from the environment, or from the Filer\'s file when it does not carry them', () => {
  assert.deepEqual(sharePointEnv({ ...ENV, SHAREPOINT_REGION: 'APC', OTHER: 'x' }, () => { throw new Error('not read'); }), { ...ENV, SHAREPOINT_REGION: 'APC' });
  const file = 'ANTHROPIC_API_KEY=never\nAZURE_TENANT_ID="tenant"\nexport AZURE_CLIENT_ID=client\nAZURE_CLIENT_SECRET=\'secret\'\n# note\n';
  assert.deepEqual(sharePointEnv({}, () => file), { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'secret' });
  assert.equal(sharePointEnv({}, () => { throw new Error('ENOENT'); }), null);
  assert.equal(sharePointEnv({ AZURE_TENANT_ID: 't' }, () => 'AZURE_CLIENT_ID=c\n'), null);
});

// ------------------------------------------------------- wording a search

test('a search is held to the Data Room whatever the words say', () => {
  assert.equal(buildQuery({ words: '"direct agreement" lenders', roomUrl: ROOM_URL }), `("direct agreement" lenders) path:"${ROOM_URL}" IsDocument:true`);
  assert.equal(buildQuery({ words: 'concession', fileType: 'word', folder: '/Usama - Backup/Active Transactions/', roomUrl: ROOM_URL }),
    `(concession) path:"${ROOM_URL}/Usama - Backup/Active Transactions" IsDocument:true (filetype:docx OR filetype:doc)`);
  // Neither the words nor the folder can point the search somewhere else.
  const sneaky = buildQuery({ words: 'salary) OR path:"https://elsewhere" (x', folder: '../../HR"', roomUrl: ROOM_URL });
  assert.ok(!/elsewhere"\s*\)/.test(sneaky));
  assert.ok(!sneaky.includes('path:"https://elsewhere'));
  assert.ok(sneaky.includes(`path:"${ROOM_URL}/HR"`));
  // An unclosed quote would be a syntax error; nothing to search for is no search.
  assert.equal(buildQuery({ words: 'step-in "rights', roomUrl: ROOM_URL }), `(step-in rights) path:"${ROOM_URL}" IsDocument:true`);
  assert.equal(buildQuery({ words: '  "" ', roomUrl: ROOM_URL }), null);
});

test('a hit is a file only when it sits inside the Data Room', () => {
  const file = hitToFile(hit('A1', 'Usama - Backup/KPT/KPT21 - Direct Agreement [AKLA][Final].docx', { summary: '<ddd/><c0>Direct</c0> <c0>Agreement</c0> In Relation <ddd/>' }), room);
  assert.equal(file.name, 'KPT21 - Direct Agreement [AKLA][Final].docx');
  assert.equal(file.folder, 'Usama - Backup/KPT');
  assert.equal(file.snippet, '… Direct Agreement In Relation …');
  assert.equal(file.webUrl, 'https://aklacopk.sharepoint.com/sites/akla-internal/Shared%20Documents/AKLA%20-%20Data%20Room/Usama%20-%20Backup/KPT/KPT21%20-%20Direct%20Agreement%20[AKLA][Final].docx');
  assert.equal(file.folderUrl, 'https://aklacopk.sharepoint.com/sites/akla-internal/Shared%20Documents/AKLA%20-%20Data%20Room/Usama%20-%20Backup/KPT');
  // Another library, a folder whose name merely starts the same, and a folder itself.
  assert.equal(hitToFile({ hitId: 'B', resource: { id: 'B', webUrl: 'https://aklacopk.sharepoint.com/sites/hr/Shared Documents/Payroll.xlsx' } }, room), null);
  assert.equal(hitToFile({ hitId: 'C', resource: { id: 'C', webUrl: `${ROOM_URL} Archive/Old.docx` } }, room), null);
  assert.equal(hitToFile(hit('D', 'Usama - Backup/KPT', { resource: { folder: {} } }), room), null);
  assert.equal(hitToFile(hit('E', 'Top.pdf'), room).folder, '');
});

test('addresses and snippets', () => {
  assert.equal(plainUrl('https://x/a%20b/'), 'https://x/a b');
  assert.equal(linkUrl('https://x/a b/c#1.docx'), 'https://x/a%20b/c%231.docx');
  // Already encoded: left as it is, never encoded twice (a name with & or # in it).
  assert.equal(linkUrl('https://x/a%20b/Terms%20%26%20Conditions%20%231.docx'), 'https://x/a%20b/Terms%20%26%20Conditions%20%231.docx');
  assert.equal(plainUrl('https://x/a%20b/Terms%20%26%20Conditions%20%231.docx'), 'https://x/a b/Terms & Conditions #1.docx');
  assert.equal(plainUrl('https://x/50% draft.docx'), 'https://x/50% draft.docx');
  assert.equal(cleanSummary('one <c0>two</c0><ddd/>three'), 'one two … three');
  assert.equal(regionFromError("Requested region 'NAM' is invalid. Only valid regions are APC."), 'APC');
  assert.equal(regionFromError('Region is required when request with application permission.'), null);
});

// ---------------------------------------------------- the search on Graph

test('the search finds the region once, keeps to Data Room files and counts the total', async () => {
  const asked = [];
  const { fetchImpl, calls } = fakeGraph((request) => {
    asked.push(request.region);
    if (request.region !== 'IND') return json({ error: { message: `Requested region ${request.region} is invalid. Only valid regions are IND.` } }, 400);
    return json({ value: [{ hitsContainers: [{ total: 1393, hits: [
      hit('A1', 'Usama - Backup/KPT/KPT21 - Direct Agreement.docx'),
      { hitId: 'X', resource: { id: 'X', webUrl: 'https://aklacopk.sharepoint.com/sites/hr/Payroll.xlsx' } },
      hit('A1', 'Usama - Backup/KPT/KPT21 - Direct Agreement.docx'),
    ] }] }] });
  });
  const logs = [];
  const sp = createSharePoint({ env: ENV, fetchImpl, log: (l) => logs.push(l) });
  const first = await sp.search({ words: 'direct agreement' });
  assert.equal(first.total, 1393);
  assert.deepEqual(first.files.map((f) => f.id), ['A1']);
  // The first guess was refused, and the refusal named the region.
  assert.deepEqual(asked, ['APC', 'IND']);
  assert.ok(logs.some((l) => l.includes('SHAREPOINT_REGION=IND')));
  await sp.search({ words: 'again' });
  assert.deepEqual(asked, ['APC', 'IND', 'IND']);
  // Signed in once, and the Data Room looked up once.
  assert.equal(calls.filter((c) => c.url.includes('login.microsoftonline.com')).length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith('/drives')).length, 1);
  const sent = calls.find((c) => c.url.endsWith('/search/query')).body.requests[0];
  assert.deepEqual(sent.entityTypes, ['driveItem']);
  assert.ok(sent.query.queryString.includes(`path:"${ROOM_URL}"`));
});

test('a pinned region is used as given, and a refusal for lack of permission says who has to act', async () => {
  const asked = [];
  const pinned = fakeGraph((request) => { asked.push(request.region); return json({ value: [{ hitsContainers: [{ total: 0, hits: [] }] }] }); });
  await createSharePoint({ env: { ...ENV, SHAREPOINT_REGION: 'EUR' }, fetchImpl: pinned.fetchImpl }).search({ words: 'x' });
  assert.deepEqual(asked, ['EUR']);

  const denied = fakeGraph(() => json({ error: { message: 'Access denied' } }, 403));
  await assert.rejects(createSharePoint({ env: ENV, fetchImpl: denied.fetchImpl }).search({ words: 'x' }), (err) => err instanceof SharePointError && err.code === 'not_approved' && /administrator/.test(err.message));

  const nowhere = fakeGraph(() => json({ error: { message: 'Region is not valid.' } }, 400));
  await assert.rejects(createSharePoint({ env: ENV, fetchImpl: nowhere.fetchImpl }).search({ words: 'x' }), (err) => err.code === 'region');
});

test('a busy SharePoint is asked again; an oversized file is not downloaded', async () => {
  let tries = 0;
  const { fetchImpl, calls } = fakeGraph(() => (++tries < 3 ? json({ error: { message: 'throttled' } }, 429, { 'Retry-After': '1' }) : json({ value: [{ hitsContainers: [{ total: 0, hits: [] }] }] })));
  const waits = [];
  const sp = createSharePoint({ env: { ...ENV, SHAREPOINT_REGION: 'APC' }, fetchImpl, wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual((await sp.search({ words: 'x' })).files, []);
  assert.deepEqual(waits, [1000, 1000]);
  await assert.rejects(sp.download({ driveId: 'drive1', id: 'big', size: 50 * 1024 * 1024 }), (err) => err.code === 'too_large');
  assert.ok(!calls.some((c) => c.url.endsWith('/content')));
  assert.deepEqual([...(await sp.download({ driveId: 'drive1', id: 'A1', size: 10 }))], [1, 2, 3]);
});

// ----------------------------------------------------------- reading text

test('text for the model: Word\'s HTML made plain, and the passages around a phrase', () => {
  assert.equal(plainText('<h1>Direct Agreement</h1><p>Between <strong>KPT</strong> &amp; the Lenders</p><table><tr><td>a</td><td>b</td></tr></table>'), 'Direct Agreement\nBetween KPT & the Lenders\na | b |');
  const text = `${'x'.repeat(1000)} the Lenders may exercise Step-In Rights on default ${'y'.repeat(1000)} step-in again`;
  const found = passagesAround(text, 'step-in', { span: 90 });
  assert.equal(found.length, 2);
  assert.ok(found[0].startsWith('…') && /Step-In Rights/.test(found[0]));
  assert.deepEqual(passagesAround(text, 'novation'), []);
  assert.deepEqual(passagesAround(text, ''), []);
});

// --------------------------------------------------------- the model loop

const file = (id, name, folder = 'Usama - Backup/KPT', extra = {}) => ({ id, driveId: 'drive1', name, folder, webUrl: `https://sp/${id}`, folderUrl: 'https://sp/folder', modified: '2026-01-24T11:47:00Z', size: 84_000, snippet: 'Direct Agreement In Relation To', ...extra });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
// The model, scripted: each call answers with the next turn.
function scripted(turns) {
  const bodies = [];
  const anthropicJson = async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const turn = turns[Math.min(bodies.length - 1, turns.length - 1)];
    return typeof turn === 'function' ? turn(body) : turn;
  };
  return { anthropicJson, bodies };
}

test('it searches in several wordings, opens what the name does not settle, and reports each file once', async () => {
  const searched = [];
  const sharepoint = {
    search: async ({ words, fileType, folder }) => {
      searched.push({ words, fileType, folder });
      return words.includes('timesheet')
        ? { total: 0, files: [] }
        : { total: 1393, files: [file('A1', 'KPT21 - Direct Agreement [AKLA][Final].docx'), file('T1', 'KPT50 - Jan Timesheets.docx')] };
    },
    download: async (f) => new TextEncoder().encode(f.id),
  };
  const { anthropicJson, bodies } = scripted([
    { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, use('u1', 'search_sharepoint', { query: '"direct agreement" lenders', file_type: 'word' }), use('u2', 'search_sharepoint', { query: 'step-in lenders', folder: 'Usama - Backup' })] },
    { stop_reason: 'tool_use', content: [use('u3', 'read_file', { file: 'f1', look_for: 'step-in' }), use('u4', 'read_file', { file: 'F9' })] },
    { stop_reason: 'tool_use', content: [use('u5', 'report_files', { files: [{ file: 'F1', why: 'The final lenders\' direct agreement for the KPT terminal.', fit: 'strong' }, { file: 'F1', why: 'again', fit: 'strong' }, { file: 'F7', why: 'made up', fit: 'strong' }, { file: 'F2', why: 'A timesheet that mentions it.', fit: 'maybe' }], note: 'Earlier drafts exist.' })] },
  ]);
  const steps = [];
  const result = await findSharePointFiles({
    question: 'the lenders direct agreement with step-in rights', sharepoint, anthropicJson, model: 'm',
    onStep: (s) => steps.push(s.text),
    readText: async (bytes, name) => `${'Opening of the agreement. '.repeat(260)} The Lenders may exercise Step-In Rights. (${name})`,
  });

  assert.deepEqual(searched, [{ words: '"direct agreement" lenders', fileType: 'word', folder: null }, { words: 'step-in lenders', fileType: null, folder: 'Usama - Backup' }]);
  assert.deepEqual(result.results.map((r) => [r.name, r.fit, r.opened]), [['KPT21 - Direct Agreement [AKLA][Final].docx', 'strong', true], ['KPT50 - Jan Timesheets.docx', 'unchecked', false]]);
  assert.equal(result.note, 'Earlier drafts exist.');
  assert.deepEqual([result.seen, result.opened, result.complete], [2, 1, true]);
  assert.deepEqual(result.searches, ['"direct agreement" lenders', 'step-in lenders']);
  assert.deepEqual(steps, ['Searching SharePoint for "direct agreement" lenders', 'Searching SharePoint for step-in lenders', 'Reading KPT21 - Direct Agreement [AKLA][Final].docx']);

  // The model's turn goes back as it came (thinking included), and both
  // results of a turn go back together in one message.
  assert.deepEqual(bodies[1].messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig' });
  const firstResults = bodies[1].messages[2].content;
  assert.deepEqual(firstResults.map((b) => b.tool_use_id), ['u1', 'u2']);
  assert.match(firstResults[0].content, /^1,393 files match/);
  assert.match(firstResults[0].content, /\[F1\] KPT21 - Direct Agreement \[AKLA\]\[Final\]\.docx\n\s+in: Usama - Backup\/KPT · changed 24 Jan 2026 · 82 KB/);
  // The second search met the same files: same handles, marked as seen.
  assert.match(firstResults[1].content, /\[F1\] .*\(seen in an earlier search\)/);
  const reads = bodies[2].messages[4].content;
  assert.match(reads[0].content, /the opening \(5,000 of [\d,]+ characters\)/);
  assert.match(reads[0].content, /Further passages mentioning "step-in":\n- …/);
  assert.equal(reads[1].is_error, true);
  // No forced tool choice, and the lawyer's words are in the first message only.
  assert.ok(bodies.every((b) => !b.tool_choice && b.model === 'm' && b.output_config.effort === 'low'));
  assert.match(bodies[0].messages[0].content, /the lenders direct agreement with step-in rights/);
});

test('scans, old Word files and unreadable files are judged by name, and the limits hold', async () => {
  const many = Array.from({ length: 12 }, (_, i) => file(`P${i}`, i === 0 ? 'Signed Deed.pdf' : i === 1 ? 'Old Letter.doc' : `Doc ${i}.docx`));
  const sharepoint = { search: async () => ({ total: 12, files: many }), download: async (f) => { if (f.id === 'P2') throw new SharePointError('too big', { code: 'too_large' }); return new Uint8Array(1); } };
  const read = (n) => use(`r${n}`, 'read_file', { file: `F${n}` });
  const { anthropicJson, bodies } = scripted([
    { stop_reason: 'tool_use', content: [use('s', 'search_sharepoint', { query: 'deed' })] },
    { stop_reason: 'tool_use', content: Array.from({ length: 11 }, (_, i) => read(i + 1)) },
    { stop_reason: 'tool_use', content: [use('done', 'report_files', { files: [] , note: 'Nothing matched.' })] },
  ]);
  const result = await findSharePointFiles({ question: 'the signed deed', sharepoint, anthropicJson, model: 'm', readText: async (_b, name) => (name.endsWith('.pdf') ? '  ' : 'Readable text of a document.') });
  const out = bodies[2].messages[4].content.map((b) => b.content);
  assert.match(out[0], /no readable text \(a scanned document\)/);
  assert.match(out[1], /is a \.doc file, which cannot be opened here/);
  assert.match(out[2], /could not be opened \(it is too large\)/);
  assert.match(out[3], /Readable text of a document/);
  // Eight files opened (the .doc was never opened), then no more.
  assert.equal(result.opened, LIMITS.reads);
  assert.match(out[10], /No more files can be opened/);
  assert.deepEqual([result.results.length, result.note, result.complete], [0, 'Nothing matched.', true]);
});

test('a model that never reports still gives the lawyer the closest files, said to be unchecked', async () => {
  const sharepoint = { search: async ({ words }) => ({ total: 2, files: [file(`${words}-1`, `${words} one.docx`), file(`${words}-2`, `${words} two.docx`)] }), download: async () => new Uint8Array(1) };
  let n = 0;
  const { anthropicJson, bodies } = scripted([() => ({ stop_reason: 'tool_use', content: [use(`u${++n}`, 'search_sharepoint', { query: `q${n}` })] })]);
  const result = await findSharePointFiles({ question: 'anything', sharepoint, anthropicJson, model: 'm' });
  assert.equal(bodies.length, LIMITS.rounds + 1);
  // Told on the last allowed lookup that it was the last.
  assert.equal(bodies[LIMITS.rounds].messages.at(-1).content.at(-1).text, 'That was the last lookup. Call report_files now with what you have found.');
  assert.equal(result.complete, false);
  assert.equal(result.results.length, 8);
  assert.ok(result.results.every((r) => r.fit === 'unchecked'));
  assert.match(result.note, /ran out of time/);

  // Answering in words instead of reporting is asked for the report once.
  const wordy = scripted([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'I think it is the first one.' }] }]);
  const none = await findSharePointFiles({ question: 'anything', sharepoint, anthropicJson: wordy.anthropicJson, model: 'm' });
  assert.equal(wordy.bodies.length, 2);
  assert.match(wordy.bodies[1].messages.at(-1).content, /Call report_files now/);
  assert.deepEqual([none.results.length, none.complete], [0, false]);
});

test('what the model cannot fix stops the search; a bad query is handed back to reword', async () => {
  const notApproved = { search: async () => { throw new SharePointError('SharePoint search is not switched on yet', { status: 503, code: 'not_approved' }); } };
  const one = scripted([{ stop_reason: 'tool_use', content: [use('u', 'search_sharepoint', { query: 'x' })] }]);
  await assert.rejects(findSharePointFiles({ question: 'q', sharepoint: notApproved, anthropicJson: one.anthropicJson, model: 'm' }), (err) => err.code === 'not_approved');

  let calls = 0;
  const flaky = { search: async () => { if (++calls === 1) throw new SharePointError('Syntax error in query', { status: 400, code: 'graph' }); return { total: 0, files: [] }; } };
  const two = scripted([
    { stop_reason: 'tool_use', content: [use('a', 'search_sharepoint', { query: 'bad' })] },
    { stop_reason: 'tool_use', content: [use('b', 'search_sharepoint', { query: 'good' }), use('c', 'search_sharepoint', { query: '   ' })] },
    { stop_reason: 'tool_use', content: [use('d', 'report_files', { files: [] })] },
  ]);
  const result = await findSharePointFiles({ question: 'q', sharepoint: flaky, anthropicJson: two.anthropicJson, model: 'm' });
  assert.equal(two.bodies[1].messages[2].content[0].is_error, true);
  assert.match(two.bodies[1].messages[2].content[0].content, /Simplify the words/);
  assert.match(two.bodies[2].messages[4].content[0].content, /No file matches: good/);
  assert.equal(two.bodies[2].messages[4].content[1].is_error, true);
  assert.deepEqual(result.results, []);

  await assert.rejects(findSharePointFiles({ question: 'q', sharepoint: flaky, anthropicJson: async () => ({ stop_reason: 'refusal', content: [] }), model: 'm' }), (err) => err.code === 'declined');
});
