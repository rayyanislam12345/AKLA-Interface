// The connector's tool registry (connector/tools.js loadToolModules and the
// `modules` deps of createHubTools), the Hub links every result carries
// (connector/hubLinks.js), and get_firm_rules (connector/tools/firmRules.js):
// a module's tools follow the built-in eight in file order, get the readers
// and helpers, answer through the same clip-and-log wrapper, and a module
// that is the wrong shape or repeats a name is refused at startup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES, MAX_RESULT_CHARS } from '../connector/tools.js';
import { DEFAULT_HUB_URL, PANE_QUERY, hubBase, hubLink, openInHub } from '../connector/hubLinks.js';
import firmRules, { firmRulesText, CONNECTOR_CITING, CONNECTOR_SOURCING, CONNECTOR_GROUNDING, TASKS } from '../connector/tools/firmRules.js';
import { FIRM_MARKDOWN_RULES, COMPLETENESS_RULES, ARTIFACT_RULES, lookingUpRules, citingRules } from '../firmRules.js';

const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const noDb = { from: () => { throw new Error('no database in this test'); } };
const make = (extra = {}) => createHubTools({ supabase: noDb, voyageKey: 'v', log: () => {}, ...extra });

/** A directory of modules, written for one test and removed after it. */
function moduleDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-tools-'));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const ARRAY_MODULE = `export default [{ name: 'say_hello', title: 'Hello', description: 'Says hello to whoever asks, which is enough of a description for a test.', inputSchema: {}, async run(input, ctx) { return 'hello ' + (ctx.userId ?? 'nobody'); } }];`;
const FUNCTION_MODULE = `export default (deps) => [{ name: 'show_deps', title: 'Deps', description: 'Reports what the registry handed the module, so the test can see it.', inputSchema: {}, async run() { return [typeof deps.supabase, deps.voyageKey, deps.hubUrl, Object.keys(deps.helpers).sort().join(','), deps.helpers.open('project', 'p1'), typeof deps.library.searchLaw].join('|'); } }, { name: 'too_long', description: 'Answers more than the cap, to show the wrapper clips a module\\'s result too.', inputSchema: {}, async run() { return 'x'.repeat(${MAX_RESULT_CHARS * 2}); } }];`;

test('loadToolModules reads the directory in name order and keeps each default export', async () => {
  const { dir, done } = moduleDir({ 'b_second.js': FUNCTION_MODULE, 'a_first.js': ARRAY_MODULE, 'notes.md': 'not a module' });
  try {
    const modules = await loadToolModules(dir);
    assert.deepEqual(modules.map((m) => m.file), ['a_first.js', 'b_second.js']);
    assert.ok(Array.isArray(modules[0].tools));
    assert.equal(typeof modules[1].tools, 'function');
  } finally { done(); }
  assert.deepEqual(await loadToolModules(join(tmpdir(), 'hub-tools-does-not-exist')), [], 'no directory, no modules');
});

test('a module\'s tools follow the built-in eight, get the deps, and answer through the wrapper', async () => {
  const { dir, done } = moduleDir({ 'b_second.js': FUNCTION_MODULE, 'a_first.js': ARRAY_MODULE });
  try {
    const lines = [];
    const list = make({ modules: await loadToolModules(dir), hubUrl: 'https://hub.test/', log: (l) => lines.push(l) });
    assert.deepEqual(list.map((t) => t.name), [...BUILT_IN_TOOL_NAMES, 'say_hello', 'show_deps', 'too_long']);
    const byName = Object.fromEntries(list.map((t) => [t.name, t]));
    assert.equal(await byName.say_hello.run({}, { userId: 'u1' }), 'hello u1');
    assert.equal(await byName.show_deps.run({}, { userId: 'u1' }), 'object|v|https://hub.test|link,matterById,needProject,needVersion,open,passagesOf,showPassages,textOf,textOfBytes,versionById,versionName|Open in Hub: https://hub.test/ai/p/p1?embed=1&host=pane|function');
    const clipped = await byName.too_long.run({}, { userId: 'u1' });
    assert.equal(clipped.length, MAX_RESULT_CHARS);
    assert.match(clipped, /\[Cut here:/);
    assert.match(lines.at(-1), /^too_long for u1: 30000 chars in \d+ ms$/);
    // A bare default export works too, for a test of one module.
    const one = make({ modules: [[{ name: 'bare_one', description: 'A tool passed without its file name, as a test of one module does.', inputSchema: {}, run: async () => 'ok' }]] });
    assert.equal(one.at(-1).name, 'bare_one');
  } finally { done(); }
});

test('a module of the wrong shape, or one that repeats a name, is refused at startup', async () => {
  const { dir, done } = moduleDir({ 'bad.js': 'export default { name: "not_a_list" };' });
  try { await assert.rejects(loadToolModules(dir), /connector\/tools\/bad\.js: the default export must be an array of tools or a function/); } finally { done(); }
  assert.throws(() => make({ modules: [{ file: 'x.js', tools: () => 'nope' }] }), /connector\/tools\/x\.js: expected an array of tools, got string/);
  assert.throws(() => make({ modules: [{ file: 'x.js', tools: [{ name: 'Bad Name', description: 'd', inputSchema: {}, run: async () => '' }] }] }), /x\.js: every tool needs a name like get_firm_rules/);
  assert.throws(() => make({ modules: [{ file: 'x.js', tools: [{ name: 'fine', description: 'd', inputSchema: {} }] }] }), /x\.js: fine needs a run\(input, ctx\) function/);
  assert.throws(() => make({ modules: [{ file: 'x.js', tools: [{ name: 'fine', description: 'd', run: async () => '' }] }] }), /x\.js: fine needs an inputSchema/);
  assert.throws(() => make({ modules: [{ file: 'x.js', tools: [{ name: 'list_projects', description: 'd', inputSchema: {}, run: async () => '' }] }] }), /x\.js: a tool named list_projects is already registered/);
  assert.throws(() => make({ modules: [firmRules, { file: 'again.js', tools: firmRules }] }), /again\.js: a tool named get_firm_rules is already registered/);
});

test('hubLink builds the site\'s pages and refuses what it cannot link', () => {
  assert.equal(DEFAULT_HUB_URL, 'https://akla-interface.vercel.app');
  // A project or version link opens the pane page (the Claude desktop app's browser pane); the precedent library stays plain.
  assert.equal(PANE_QUERY, '?embed=1&host=pane');
  assert.equal(hubBase(undefined), DEFAULT_HUB_URL);
  assert.equal(hubBase('  https://hub.test///  '), 'https://hub.test');
  assert.equal(hubLink('project', 'p1'), `${DEFAULT_HUB_URL}/ai/p/p1?embed=1&host=pane`);
  assert.equal(hubLink('version', V1, 'https://hub.test/'), `https://hub.test/ai/d/${V1}?embed=1&host=pane`);
  assert.equal(hubLink('precedents', null, 'https://hub.test'), 'https://hub.test/precedent-library');
  assert.equal(openInHub('project', 'p1', 'https://hub.test'), 'Open in Hub: https://hub.test/ai/p/p1?embed=1&host=pane');
  assert.throws(() => hubLink('chat', 'c1'), /Unknown Hub link kind: chat/);
  assert.throws(() => hubLink('version', ''), /A version link needs an id/);
});

test('get_firm_rules returns the Hub\'s own rules, by task, in the connector\'s citing convention', async () => {
  const list = make({ modules: [firmRules] });
  const tool = list.find((t) => t.name === 'get_firm_rules');
  assert.ok(tool, 'registered');
  assert.deepEqual(TASKS, ['draft', 'answer', 'review']);
  const draft = await tool.run({ task: 'draft' }, { userId: 'u1' });
  assert.equal(draft, firmRulesText('draft'));
  assert.equal(await tool.run({}, { userId: 'u1' }), draft, 'draft is the default');
  // The search comes first and unconditionally (claude.ai retrieves nothing up front), then the Hub's own LOOKING THINGS UP sentence.
  assert.match(draft, /^AKLA's rules for drafting from the Hub\. Follow them for the whole task\.\n\nSEARCH FIRST: before you draft or answer on a point that turns on a law, a precedent or a project's documents, search: search_precedents \(or find_precedent_clauses\) and search_law_library, and search_project_documents for a project; nothing is retrieved for you here\. Ground every legal statement in a passage you have been shown and cite it by number; distinguish what the project's documents say, what the firm's precedent shows, and what the law itself provides, naming the Act and section when you rely on a statute\.[^\n]*\n\nLOOKING THINGS UP: you have tools — search_precedents, search_law_library, read_act_section, and for a project list_projects, /);
  // The very strings server.js prompts with, so the two cannot drift.
  assert.ok(draft.includes(FIRM_MARKDOWN_RULES));
  assert.ok(draft.includes(COMPLETENESS_RULES));
  assert.ok(draft.includes(CONNECTOR_GROUNDING) && draft.includes(CONNECTOR_SOURCING) && draft.includes(CONNECTOR_CITING));
  assert.ok(draft.indexOf(CONNECTOR_GROUNDING) < draft.indexOf(CONNECTOR_SOURCING));
  assert.doesNotMatch(draft, /look_up_law_online/, 'the connector has no online lookup');
  assert.doesNotMatch(draft, /this project's documents/, 'claude.ai is not inside one project');
  assert.ok(!draft.includes(ARTIFACT_RULES) && !draft.includes('<artifact kind='), 'the Hub panel\'s artifact tag is not for claude.ai');
  assert.match(draft, /do not wrap it in the Hub's <artifact> tag/);
  assert.match(draft, /numbered from 1 within that result/);
  assert.match(draft, /Quote statutory text only from a passage in front of you, word for word; to quote a provision you have not been shown in full, read it with read_act_section first/);
  const answer = await tool.run({ task: 'answer' }, { userId: 'u1' });
  assert.match(answer, /^AKLA's rules for answering from the Hub\./);
  assert.ok(answer.includes(CONNECTOR_GROUNDING) && answer.includes(CONNECTOR_SOURCING) && answer.includes(CONNECTOR_CITING));
  assert.ok(!answer.includes(FIRM_MARKDOWN_RULES) && !answer.includes(COMPLETENESS_RULES));
  const review = await tool.run({ task: 'review' }, { userId: 'u1' });
  assert.match(review, /^AKLA's rules for reviewing from the Hub\./);
  assert.match(review, /REVIEWING: read the document with get_document_summary and then read_document in slices/);
  assert.ok(review.includes(CONNECTOR_GROUNDING));
  assert.ok(draft.length < MAX_RESULT_CHARS);
});

test('firmRules.js carries the Hub chat\'s sentences unchanged for server.js', () => {
  assert.match(FIRM_MARKDOWN_RULES, /^The document is delivered as a Word file in the firm's house format/);
  assert.match(FIRM_MARKDOWN_RULES, /\[\[AKLA Comment: The Firm notes that …\]\]/);
  assert.match(COMPLETENESS_RULES, /^The document must be COMPLETE and ready to edit/);
  assert.match(ARTIFACT_RULES, /<artifact kind="draft\|memo" title="Short document title">/);
  const answering = lookingUpRules({ toolNames: 'a, b', matterId: 'm', editTools: false });
  assert.match(answering, /^LOOKING THINGS UP: you have tools — a, b\. Use them mid-answer whenever the answer turns on what a law, a precedent or this project's documents say/);
  const editing = lookingUpRules({ toolNames: 'a, b', matterId: null, editTools: true });
  assert.match(editing, /Before you propose a change that turns on what a law, a precedent say, look it up/);
  assert.match(editing, /never "\[Source n\]"/);
  assert.match(citingRules({ withTools: true }), /^CITING: every passage you are shown — retrieved for this message, returned by a tool, or listed under EARLIER SOURCES IN THIS CHAT/);
  assert.match(citingRules(), /retrieved for this message or listed under EARLIER SOURCES/);
  assert.doesNotMatch(citingRules(), /read_act_section/);
});
