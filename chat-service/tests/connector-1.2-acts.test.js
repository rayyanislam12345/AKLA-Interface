// list_acts and get_act_outline (connector/tools/acts.js) against stubbed
// library readers: the laws are listed by their library names, an Act named
// loosely lands on the library's entry, the outline is one "s. n — Heading"
// line per section from the same index the Hub's searches use, a long
// outline comes in pages under the cap, and a law the library does not hold
// is refused with the closest names.
import test from 'node:test';
import assert from 'node:assert/strict';
import acts, { outlineOf, outlineText, OUTLINE_CHARS } from '../connector/tools/acts.js';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES, MAX_RESULT_CHARS } from '../connector/tools.js';
import { sectionIndex } from '../libraryTools.js';

// An Act laid out the way the library holds the Companies Act, 2017 (the
// fixture of libraryTools.test.js): a contents list, the body, a Schedule
// numbered from 1 again.
const ACT = [
  'Updated till 7.10.2022 THE COMPANIES ACT, 2017 CONTENTS PART XII PROVISIONS REGARDING INVESTMENTS SECTIONS.',
  '195. Power to borrow. 196. Registration of charges. 197. Restriction on investments. 198. Loans to directors. 199. Investments in associated companies and undertaking. 200. Investments of company to be held in its own name. 201. Method of contracting.',
  'Page 12 of 401 PART XII PROVISIONS REGARDING INVESTMENTS',
  '195. Power to borrow.—The board may borrow on behalf of the company within the limits the members set by special resolution.',
  '196. Registration of charges.—Every charge created by a company shall be registered with the registrar, see Gazette p. 198. This applies to charges created before the commencement of this Act too.',
  '197. Restriction on investments.—A company shall not make an investment except as this Part allows.',
  '198. Loans to directors.—No company shall make any loan to a director except with the approval of the members.',
  '199. Investments in associated companies and undertaking.—(1) A company shall not make any investment in any of its associated companies or associated undertakings except under the authority of a special resolution. (2) The return on any such investment shall be arms-length and in accordance with the trade policy of the company, as provided under section 200. Nothing here applies to a bank.',
  '200. Investments of company to be held in its own name.—(1) All investments made by a company on its own behalf shall be made and held by it in its own name.',
  '201. Method of contracting.—A contract which, if made between individuals, would be required by law to be in writing may be made on behalf of the company in writing signed by any person acting under its authority.',
  'FIRST SCHEDULE 1. Interpretation.—In these regulations the Act means the Companies Act, 2017. 2. Share capital.—The authorised capital is as stated in the memorandum.',
].join(' ');

const COMPANIES = 'Companies Act, 2017';
const CONTRACT = 'Contract Act, 1872';
const doc = { act_name: COMPANIES, text: ACT, index: sectionIndex(ACT), source_url: 'https://pakistancode.gov.pk/companies-act-2017.pdf' };

// The library's readers, stubbed: two laws held, only one with text.
function stubLibrary({ acts: held = [{ act_name: COMPANIES, chunk_count: 400 }, { act_name: CONTRACT, chunk_count: 60 }] } = {}) {
  const calls = [];
  return {
    calls,
    listActs: async () => { calls.push('listActs'); return held; },
    actText: async (_sb, name) => { calls.push(`actText:${name}`); return name === COMPANIES ? doc : null; },
  };
}

function make({ library = stubLibrary(), ...over } = {}) {
  const lines = [];
  const list = createHubTools({ supabase: {}, voyageKey: 'k', library, modules: [acts], log: (l) => lines.push(l), ...over });
  const by = Object.fromEntries(list.map((t) => [t.name, t]));
  return { list, by, lines, library };
}

const ctx = { userId: 'user-1' };

test('the module adds list_acts and get_act_outline after the built-in eight, and loads from the real directory', async () => {
  const { list } = make();
  assert.deepEqual(list.slice(0, 8).map((t) => t.name), [...BUILT_IN_TOOL_NAMES]);
  assert.deepEqual(list.slice(8).map((t) => t.name), ['list_acts', 'get_act_outline']);
  for (const t of list.slice(8)) {
    assert.ok(t.title && t.description.length > 80, `${t.name} describes itself`);
    assert.equal(typeof t.inputSchema, 'object');
  }
  const loaded = await loadToolModules();
  const entry = loaded.find((m) => m.file === 'acts.js');
  assert.ok(entry, 'connector/tools/acts.js is loaded with the directory');
  assert.equal(typeof entry.tools, 'function');
  assert.deepEqual(entry.tools({ supabase: {}, library: {} }).map((t) => t.name), ['list_acts', 'get_act_outline']);
});

test('list_acts names every law held, as the library spells it', async () => {
  const { by, lines, library } = make();
  const out = await by.list_acts.run({}, ctx);
  assert.match(out, /^2 laws in the firm's law library/);
  assert.match(out, /as written here to search_law_library, get_act_outline or read_act_section/);
  assert.match(out, /\n- Companies Act, 2017\n- Contract Act, 1872$/);
  assert.deepEqual(library.calls, ['listActs']);
  assert.ok(lines.some((l) => l.startsWith('list_acts for user-1:')), 'the wrapper logs the call');

  const empty = make({ library: stubLibrary({ acts: [] }) });
  assert.equal(await empty.by.list_acts.run({}, ctx), 'The law library holds no laws yet.');
  const one = make({ library: stubLibrary({ acts: [{ act_name: CONTRACT, chunk_count: 1 }] }) });
  assert.match(await one.by.list_acts.run({}, ctx), /^1 law in the firm's law library/);
});

test('get_act_outline lists the body sections of an Act named loosely, with the official link and the Schedules note', async () => {
  const { by, library } = make();
  const out = await by.get_act_outline.run({ act: 'companies act 2017' }, ctx);
  assert.match(out, /^Companies Act, 2017 \(asked for “companies act 2017”\): 7 sections in the library's copy\. Read one in full with read_act_section \(act "Companies Act, 2017", section "<number>"\)\.\nLink: https:\/\/pakistancode\.gov\.pk\/companies-act-2017\.pdf\n\n/);
  const body = out.split('\n\n')[1].split('\n');
  assert.deepEqual(body, [
    's. 195 — Power to borrow',
    's. 196 — Registration of charges',
    's. 197 — Restriction on investments',
    's. 198 — Loans to directors',
    's. 199 — Investments in associated companies and undertaking',
    's. 200 — Investments of company to be held in its own name',
    's. 201 — Method of contracting',
  ]);
  // The contents list and the Schedule's "1. Interpretation" are not sections.
  assert.equal((out.match(/^s\. /gm) ?? []).length, 7);
  assert.ok(out.endsWith('[End of the sections. Schedules follow in the text, their paragraphs numbered from 1 again.]'));
  assert.doesNotMatch(out, /Open in Hub/);
  assert.deepEqual(library.calls, ['listActs', `actText:${COMPANIES}`]);

  // The exact library name is not echoed back as "asked for".
  const exact = await by.get_act_outline.run({ act: COMPANIES }, ctx);
  assert.match(exact, /^Companies Act, 2017: 7 sections/);
});

test('get_act_outline refuses a missing or unknown law and an Act without text, naming the closest held', async () => {
  const { by } = make();
  await assert.rejects(by.get_act_outline.run({}, ctx), /The act is needed/);
  await assert.rejects(by.get_act_outline.run({ act: 'Companies Ordinance 1984' }, ctx), /holds no law matching "Companies Ordinance 1984"\. Closest held: Companies Act, 2017\. list_acts gives every law held\./);
  await assert.rejects(by.get_act_outline.run({ act: 'Zakat Ordinance' }, ctx), /holds no law matching "Zakat Ordinance"\. list_acts gives every law held\./);
  await assert.rejects(by.get_act_outline.run({ act: 'Contract Act 1872' }, ctx), /Contract Act, 1872 has no text in the law library\./);
});

test('outlineOf reads headings from the index the searches use, and says when there are none', () => {
  const { sections, schedules } = outlineOf(doc);
  assert.equal(sections.length, 7);
  assert.deepEqual(sections[4], { section: '199', heading: 'Investments in associated companies and undertaking' });
  assert.equal(schedules, true);
  assert.deepEqual(outlineOf({ text: 'No numbered headings here.', index: [] }), { sections: [], schedules: false });
  // A heading that ends at its full stop, and one with no words after the number.
  const plain = '1. Short title. This Act may be called the Test Act. 2. (1) Nothing. 3. Repeal.—The old Act is repealed.';
  const got = outlineOf({ text: plain, index: [{ section: '1', index: 0 }, { section: '2', index: plain.indexOf('2. (1)') }, { section: '3', index: plain.indexOf('3. Repeal') }] });
  assert.deepEqual(got.sections, [{ section: '1', heading: 'Short title' }, { section: '2', heading: '(1) Nothing' }, { section: '3', heading: 'Repeal' }]);
  assert.equal(outlineText({ act_name: 'Empty Act, 2000' }, { sections: [], schedules: false }), "The library's copy of Empty Act, 2000 has no section headings the Hub can tell apart. Search it by subject with search_law_library instead.");
});

test('a long outline comes in pages under the cap, each saying where the next starts', async () => {
  // 900 sections with 80-character headings: about 80,000 characters of lines.
  const sections = Array.from({ length: 900 }, (_, i) => ({ section: String(i + 1), heading: `Heading ${i + 1} ${'x'.repeat(70)}` }));
  const big = { act_name: 'Long Act, 2020', text: '', index: [] };
  const library = stubLibrary({ acts: [{ act_name: 'Long Act, 2020', chunk_count: 2000 }] });
  let held = big;
  library.actText = async () => held;
  const { by } = make({ library });
  // The tool pages what outlineOf finds; here outlineOf finds nothing, so page the pure printer and the tool's `from` handling separately.
  const first = outlineText(big, { sections, schedules: false }, 0);
  assert.ok(first.length <= MAX_RESULT_CHARS, `a page is under the cap (${first.length})`);
  assert.match(first, /^Long Act, 2020: 900 sections in the library's copy; sections 1–(\d+) of the outline\./);
  const end = Number(/from: (\d+)\.\]$/.exec(first)[1]);
  assert.ok(end > 100 && end < 900, `the first page stops part way (${end})`);
  assert.ok(first.includes(`\ns. ${end} — Heading ${end} `) && !first.includes(`\ns. ${end + 1} — `), 'the page ends at the section before `from`');
  assert.doesNotMatch(first, /Link:/);

  const second = outlineText(big, { sections, schedules: false }, end);
  assert.match(second, new RegExp(`sections ${end + 1}–\\d+ of the outline`));
  assert.ok(second.split('\n\n')[1].startsWith(`s. ${end + 1} — Heading ${end + 1} `));
  // Walk to the end: every page under the cap, the last one closing the outline, no line lost or repeated.
  let from = 0;
  const seen = [];
  for (let guard = 0; guard < 20; guard++) {
    const page = outlineText(big, { sections, schedules: false }, from);
    assert.ok(page.length <= OUTLINE_CHARS + 400);
    seen.push(...page.split('\n\n')[1].split('\n'));
    const next = /from: (\d+)\.\]$/.exec(page);
    if (!next) { assert.ok(page.endsWith('[End of the outline.]')); break; }
    from = Number(next[1]);
  }
  assert.deepEqual(seen, sections.map((s) => `s. ${s.section} — ${s.heading}`));
  assert.equal(outlineText(big, { sections, schedules: false }, 900), "Long Act, 2020's outline has 900 sections; there is nothing at position 900. Call again with from: 0.");
  // One line longer than the budget is still shown, on its own.
  const huge = [{ section: '1', heading: 'y'.repeat(OUTLINE_CHARS + 10) }, { section: '2', heading: 'z' }];
  const lone = outlineText(big, { sections: huge, schedules: false }, 0);
  assert.ok(lone.includes('s. 1 — y') && lone.endsWith('[The outline continues: call get_act_outline again with from: 1.]'));

  // Through the tool, on a text the library's own index reads: 900 body
  // sections, paged by `from`; a bad `from` means 0.
  const text = sections.map((s) => `${s.section}. ${s.heading}.—Section ${s.section} of this Act provides for the matter in its heading.`).join(' ');
  held = { act_name: 'Long Act, 2020', text, index: sectionIndex(text), source_url: null };
  const page1 = await by.get_act_outline.run({ act: 'Long Act 2020', from: -3 }, ctx);
  assert.ok(page1.length <= MAX_RESULT_CHARS && !page1.includes('[Cut here'), 'the wrapper has nothing to cut');
  assert.match(page1, /^Long Act, 2020 \(asked for “Long Act 2020”\): 900 sections in the library's copy; sections 1–\d+ of the outline\./);
  assert.ok(page1.split('\n\n')[1].startsWith('s. 1 — Heading 1 '));
  const next = Number(/from: (\d+)\.\]$/.exec(page1)[1]);
  const page2 = await by.get_act_outline.run({ act: 'Long Act 2020', from: next }, ctx);
  assert.ok(page2.split('\n\n')[1].startsWith(`s. ${next + 1} — Heading ${next + 1} `));
  assert.match(await by.get_act_outline.run({ act: 'Long Act 2020', from: 900 }, ctx), /there is nothing at position 900/);
});
