// The firm's skills in the connector (connector/tools/skills.js): list_skills
// lists the ai_skills rows with who added each and when, paged by a
// character budget, and read_skill reads one skill's instructions (the
// column the Hub fills at upload with the SKILL.md body) in slices, with
// the files an uploaded skill carries named. Both read-only. The database
// is stubbed; the front-matter reader is claudeSkills.js's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES, MAX_RESULT_CHARS, MAX_READ_CHARS, DEFAULT_READ_CHARS } from '../connector/tools.js';
import { DEFAULT_HUB_URL } from '../connector/hubLinks.js';
import skills, { skillsLink, openSkills, filesOf, instructionsOf, personName, skillText, SKILLS_PAGE_CHARS, MAX_FILES_SHOWN, MAX_SKILLS } from '../connector/tools/skills.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const S_AGENDA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S_DD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S_MEMO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const S_PASTED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const S_EMPTY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const S_NONE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

// A Supabase client over plain arrays: eq/in/order/limit apply to the
// table's rows; a table in `errors` answers with that error instead.
function fakeSupabase(tables, errors = {}) {
  const calls = [];
  const chain = (table) => {
    let rows = [...(tables[table] ?? [])];
    let single = false;
    const q = {
      select(cols) { calls.push(`${table}: ${cols}`); return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      in(col, vals) { calls.push(`${table} in ${col}: ${[...vals].sort().join(',')}`); rows = rows.filter((r) => vals.includes(r[col])); return q; },
      order(col, { ascending = true } = {}) { rows.sort((a, b) => ((a[col] ?? '') > (b[col] ?? '') ? 1 : (a[col] ?? '') < (b[col] ?? '') ? -1 : 0) * (ascending ? 1 : -1)); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      maybeSingle() { single = true; return q; },
      then(ok, bad) {
        const error = errors[table] ? { message: errors[table] } : null;
        return Promise.resolve(error ? { data: null, error } : { data: single ? rows[0] ?? null : rows, error: null }).then(ok, bad);
      },
    };
    return q;
  };
  return { calls, from: chain };
}

const SKILL_MD_BODY = Array.from({ length: 12 }, (_, i) => `## Step ${i + 1}\n\nAsk the person what they did today, how long each item took and what they will do tomorrow; write the Daily Agenda for the next working day and the Daily Timesheet for today in the navy and gold table.`).join('\n\n');
const longInstructions = Array.from({ length: 300 }, (_, i) => `${i + 1}. Audit the draft volume against the house standard: A4 portrait, Arial 11, navy and gold tables, blue AKLA Comments, red AKLA Action Items, glossary, Annexure A.`).join('\n\n');

function fixtures() {
  return {
    ai_skills: [
      { id: S_AGENDA, name: 'akla-daily-agenda', description: 'Write an AKLA employee\'s end-of-day Daily Agenda and Daily Timesheet as a Word file in the firm\'s exact format.', kind: 'claude_skill', produces_document: false, instructions: SKILL_MD_BODY, skill_files: [{ path: 'akla-daily-agenda/SKILL.md', size: 4000 }, { path: 'akla-daily-agenda/scripts/build_agenda.py', size: 9000 }, { path: 'akla-daily-agenda/templates/Daily-Agenda-AKLA.docx', size: 30000 }, { path: 'akla-daily-agenda/references/format.md', size: 1200 }], created_by: U1, created_at: '2026-10-02T06:00:00Z', updated_at: '2026-10-02T06:00:00Z', anthropic_skill_id: 'skill_01', anthropic_version_id: 'v1' },
      { id: S_DD, name: 'akla-dd-format', description: 'Clean up a due diligence volume to AKLA gold-standard format.', kind: 'claude_skill', produces_document: false, instructions: longInstructions, skill_files: [{ path: 'akla-dd-format/SKILL.md', size: 100 }], created_by: U2, created_at: '2026-09-20T06:00:00Z', updated_at: '2026-10-11T09:00:00Z', anthropic_skill_id: 'skill_02', anthropic_version_id: 'v3' },
      { id: S_MEMO, name: 'Notes memo', description: 'A short "Notes On" memo in house format.', kind: 'instructions', produces_document: true, instructions: 'Write a tight memo: what the document does, the handful of things that matter, what to watch.', skill_files: [], created_by: U3, created_at: '2026-09-16T06:00:00Z', updated_at: '2026-09-16T07:30:00Z', anthropic_skill_id: null, anthropic_version_id: null },
      { id: S_PASTED, name: 'Pasted skill', description: null, kind: 'instructions', produces_document: false, instructions: '---\nname: pasted-skill\ndescription: >\n  Folded over\n  two lines.\n---\n\nThe body after the front matter.\n', skill_files: [], created_by: null, created_at: '2026-09-18T06:00:00Z', updated_at: '2026-09-18T06:00:00Z', anthropic_skill_id: null, anthropic_version_id: null },
      { id: S_EMPTY, name: 'Empty skill', description: 'Nothing in it yet.', kind: 'instructions', produces_document: false, instructions: '   \n', skill_files: null, created_by: U1, created_at: '2026-10-10T06:00:00Z', updated_at: '2026-10-10T06:00:00Z', anthropic_skill_id: null, anthropic_version_id: null },
    ],
    profiles: [
      { id: U1, full_name: 'Rayyan Islam', email: 'rayyan@akla.test' },
      { id: U2, full_name: null, email: 'associate@akla.test' },
      // U3 has no profile row: the by-line goes without a name.
    ],
  };
}

function tools(extra = {}, tables = fixtures(), errors = {}) {
  const supabase = fakeSupabase(tables, errors);
  const list = createHubTools({ supabase, voyageKey: 'v', log: () => {}, modules: [skills], ...extra });
  const byName = Object.fromEntries(list.map((t) => [t.name, t]));
  return { supabase, list, byName, run: (name, input) => byName[name].run(input, { userId: U1 }) };
}

test('the two skills tools register after the built-in eight, read-only, through the directory and on their own', async () => {
  const { list } = tools();
  assert.deepEqual(list.map((t) => t.name), [...BUILT_IN_TOOL_NAMES, 'list_skills', 'read_skill']);
  for (const t of list.slice(BUILT_IN_TOOL_NAMES.length)) {
    assert.ok(t.title && t.description.length > 80, `${t.name} describes itself for a lawyer's Claude`);
    assert.match(t.description, /Read-only; it changes nothing\./, `${t.name} says what it changes`);
    assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name} has an input schema`);
  }
  for (const t of skills({ supabase: null, hubUrl: null })) {
    assert.notEqual(t.write, true, `${t.name} is not a write tool`);
    assert.ok(t.annotations === undefined || t.annotations.readOnlyHint === true, `${t.name} stays read-only (app.js marks a tool without annotations so)`);
  }
  const loaded = await loadToolModules();
  assert.ok(loaded.some((m) => m.file === 'skills.js'), 'connector.js loads it with the rest');
  const names = createHubTools({ supabase: { from() { throw new Error('no db'); } }, voyageKey: 'v', log: () => {}, modules: loaded }).map((t) => t.name);
  for (const n of ['list_skills', 'read_skill']) assert.ok(names.includes(n), `${n} is registered from the directory`);
  assert.equal(new Set(names).size, names.length, 'no name twice');
});

test('the pure helpers: the Hub link, the files of a zip skill, the instructions without front matter, a person\'s name', () => {
  assert.equal(skillsLink(), `${DEFAULT_HUB_URL}/ai`);
  assert.equal(openSkills('https://hub.test/'), 'Open in Hub: https://hub.test/ai');
  const [agenda, , memo, pasted, empty] = fixtures().ai_skills;
  assert.deepEqual(filesOf(agenda), ['references/format.md', 'scripts/build_agenda.py', 'templates/Daily-Agenda-AKLA.docx'], 'the skill folder and SKILL.md are left out, the rest in name order');
  assert.deepEqual(filesOf(memo), []);
  assert.deepEqual(filesOf({ skill_files: 'not a list' }), []);
  assert.deepEqual(filesOf({ skill_files: [{ path: 'x/SKILL.md' }, { size: 1 }, { path: ' ' }] }), []);
  assert.equal(instructionsOf(pasted), 'The body after the front matter.', 'front matter pasted into a Hub skill is not shown as instructions');
  assert.equal(instructionsOf({ instructions: 'Plain\r\ntext\r\n' }), 'Plain\ntext');
  assert.equal(instructionsOf(empty), '');
  assert.equal(instructionsOf({}), '');
  assert.equal(personName({ full_name: 'Rayyan Islam', email: 'r@akla.test' }), 'Rayyan Islam');
  assert.equal(personName({ full_name: '  ', email: 'r@akla.test' }), 'r@akla.test');
  assert.equal(personName({}), null);
  assert.equal(personName(null), null);
  const names = new Map([[U1, 'Rayyan Islam']]);
  assert.equal(skillText(agenda, names), [
    '- akla-daily-agenda',
    `  skillId: ${S_AGENDA}`,
    '  Write an AKLA employee\'s end-of-day Daily Agenda and Daily Timesheet as a Word file in the firm\'s exact format.',
    '  uploaded as a Claude skill (.zip), with 3 files (scripts, references or templates that run only in the Hub); answers in the chat',
    '  by Rayyan Islam, added 2 Oct 2026',
  ].join('\n'));
  assert.equal(skillText(pasted, names), [
    '- Pasted skill',
    `  skillId: ${S_PASTED}`,
    '  written in the Hub; answers in the chat',
    '  added 18 Sept 2026',
  ].join('\n'), 'no description line without one, no name without a person');
});

test('list_skills lists every skill by name with its id, kind, result, who added it and when, and one Hub link', async () => {
  const { run, supabase } = tools({ hubUrl: 'https://hub.test' });
  const out = await run('list_skills', {});
  assert.match(out, /^5 skills on the Hub, by name: 2 uploaded as Claude skills, 3 written in the Hub; 1 produces a document\. read_skill gives a skill's instructions\.\nOpen in Hub: https:\/\/hub\.test\/ai\n/);
  const names = [...out.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(names, ['Empty skill', 'Notes memo', 'Pasted skill', 'akla-daily-agenda', 'akla-dd-format'], 'the database\'s name order');
  assert.match(out, new RegExp(`- akla-daily-agenda\\n  skillId: ${S_AGENDA}\\n  Write an AKLA employee's[^\\n]+\\n  uploaded as a Claude skill \\(\\.zip\\), with 3 files \\(scripts, references or templates that run only in the Hub\\); answers in the chat\\n  by Rayyan Islam, added 2 Oct 2026\\n`));
  assert.match(out, new RegExp(`- akla-dd-format\\n  skillId: ${S_DD}\\n  Clean up[^\\n]+\\n  uploaded as a Claude skill \\(\\.zip\\); answers in the chat\\n  by associate@akla\\.test, added 20 Sept 2026, changed 11 Oct 2026\\n`), 'a zip with only its SKILL.md names no files; a person without a full name is their email; a later change is dated');
  assert.match(out, new RegExp(`- Notes memo\\n  skillId: ${S_MEMO}\\n  A short "Notes On" memo in house format\\.\\n  written in the Hub; produces a document \\(a memo or draft the Hub saves as Word\\)\\n  added 16 Sept 2026\\n`), 'no profile row, no name; a same-day update is not a change');
  assert.match(out, /- Empty skill\n  skillId: [^\n]+\n  Nothing in it yet\.\n  written in the Hub; answers in the chat\n  by Rayyan Islam, added 10 Oct 2026\n/);
  assert.equal((out.match(/Open in Hub:/g) ?? []).length, 1, 'skills have one page on the Hub');
  assert.match(out, /\n\n\[End of the list\.\]$/);
  assert.deepEqual(supabase.calls, [
    'ai_skills: id, name, description, kind, produces_document, skill_files, created_by, created_at, updated_at',
    'profiles: id, full_name, email',
    `profiles in id: ${[U1, U2, U3].sort().join(',')}`,
  ], 'two queries: the skills, then the distinct people in one');
  assert.doesNotMatch(out, /INSTRUCTIONS|Step 1|Audit the draft/, 'the list never carries the instructions');
});

test('list_skills: no skills, a failing profiles read, and a failing skills read', async () => {
  const empty = tools({ hubUrl: 'https://hub.test' }, { ai_skills: [] });
  assert.equal(await empty.run('list_skills', {}), 'The firm has no skills on the Hub yet. An admin adds one in the Hub\'s Skills dialog.\nOpen in Hub: https://hub.test/ai');
  assert.equal(empty.supabase.calls.length, 1, 'no people asked for when there is nobody');
  const noProfiles = tools({}, fixtures(), { profiles: 'permission denied' });
  const out = await noProfiles.run('list_skills', {});
  assert.match(out, /^5 skills on the Hub/);
  assert.match(out, /- akla-daily-agenda\n[^\n]+\n[^\n]+\n[^\n]+\n  added 2 Oct 2026\n/, 'the list stands without the names');
  assert.doesNotMatch(out, /by Rayyan/);
  const broken = tools({}, fixtures(), { ai_skills: 'relation does not exist' });
  await assert.rejects(broken.run('list_skills', {}), /^Error: Could not list the firm's skills: relation does not exist$/);
});

test('list_skills pages by a character budget from the skill number asked, under the result cap, and says where it continues', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: `s${String(i).padStart(3, '0')}`, name: `Skill ${String(i).padStart(3, '0')}`, description: `${'A description of what the skill is for and when to use it. '.repeat(8)}`, kind: i % 3 ? 'instructions' : 'claude_skill', produces_document: i % 2 === 0, instructions: 'x', skill_files: [], created_by: U1, created_at: '2026-10-02T06:00:00Z', updated_at: '2026-10-02T06:00:00Z' }));
  assert.ok(rows.length <= MAX_SKILLS);
  const { run } = tools({ hubUrl: 'https://hub.test' }, { ai_skills: rows, profiles: fixtures().profiles });
  const page1 = await run('list_skills', {});
  assert.match(page1, /^120 skills on the Hub, by name: 40 uploaded as Claude skills, 80 written in the Hub; 60 produce a document\./);
  assert.doesNotMatch(page1, /Skills 1 to 120/, 'the first page does not say where it starts');
  const shown1 = (page1.match(/^- Skill /gm) ?? []).length;
  assert.ok(shown1 > 10 && shown1 < 120, `a page holds some but not all (${shown1})`);
  assert.ok(page1.length <= SKILLS_PAGE_CHARS + 200 && page1.length < MAX_RESULT_CHARS && !page1.includes('[Cut here'), `page of ${page1.length} chars is never cut`);
  const next = Number(/\[The list continues: call list_skills again with from: (\d+)\.\]$/.exec(page1)?.[1]);
  assert.equal(next, shown1 + 1, 'continues at the first skill not shown');
  assert.match(page1, /- Skill 000\n/);
  const page2 = await run('list_skills', { from: next });
  assert.match(page2, new RegExp(`read_skill gives a skill's instructions\\. Skills ${next} to 120\\.\\n`));
  assert.match(page2, new RegExp(`\\n- Skill ${String(next - 1).padStart(3, '0')}\\n`), 'the page starts where the last one stopped');
  assert.doesNotMatch(page2, /- Skill 000\n/);
  let last = page2;
  for (let i = 0; i < 10 && !/\[End of the list\.\]$/.test(last); i++) {
    const from = Number(/from: (\d+)\.\]$/.exec(last)[1]);
    last = await run('list_skills', { from });
  }
  assert.match(last, /- Skill 119\n[\s\S]*\[End of the list\.\]$/, 'the pages reach the end');
  const beyond = await run('list_skills', { from: 500 });
  assert.match(beyond, /Skills 120 to 120\.\n[\s\S]*- Skill 119\n[\s\S]*\[End of the list\.\]$/, 'past the end, the last skill');
});

test('read_skill reads the instructions in slices with the skill\'s head, its files, the Hub link and where to continue', async () => {
  const { run, supabase } = tools({ hubUrl: 'https://hub.test' });
  const out = await run('read_skill', { skillId: S_AGENDA });
  const headEnd = out.indexOf('\n\nINSTRUCTIONS:\n\n');
  assert.ok(headEnd > 0);
  assert.equal(out.slice(0, headEnd), [
    'The firm\'s skill "akla-daily-agenda", uploaded as a Claude skill (.zip), by Rayyan Islam, added 2 Oct 2026; answers in the chat.',
    'What it is for: Write an AKLA employee\'s end-of-day Daily Agenda and Daily Timesheet as a Word file in the firm\'s exact format.',
    'Files in the skill (3; they run only in the Hub, where the skill runs in Anthropic\'s sandbox): references/format.md, scripts/build_agenda.py, templates/Daily-Agenda-AKLA.docx.',
    'Open in Hub: https://hub.test/ai',
    `Characters 1–${SKILL_MD_BODY.length.toLocaleString('en')} of ${SKILL_MD_BODY.length.toLocaleString('en')}.`,
  ].join('\n'));
  assert.equal(out.slice(headEnd), `\n\nINSTRUCTIONS:\n\n${SKILL_MD_BODY}\n\n[End of the instructions.]`);
  assert.deepEqual(supabase.calls, [
    'ai_skills: id, name, description, instructions, kind, produces_document, skill_files, created_by, created_at, updated_at',
    'profiles: id, full_name, email',
    `profiles in id: ${U1}`,
  ]);

  // A long skill comes in slices of up to MAX_READ_CHARS.
  const p1 = await run('read_skill', { skillId: S_DD });
  assert.match(p1, /^The firm's skill "akla-dd-format", uploaded as a Claude skill \(\.zip\), by associate@akla\.test, added 20 Sept 2026, changed 11 Oct 2026; answers in the chat\.\nWhat it is for: Clean up[^\n]+\nOpen in Hub: https:\/\/hub\.test\/ai\n/);
  assert.doesNotMatch(p1, /Files in the skill/, 'a zip holding only SKILL.md lists no files');
  assert.match(p1, new RegExp(`\\nCharacters 1–${DEFAULT_READ_CHARS.toLocaleString('en')} of ${longInstructions.length.toLocaleString('en')}\\.\\n\\nINSTRUCTIONS:\\n\\n1\\. Audit`));
  assert.match(p1, new RegExp(`\\n\\n\\[The instructions continue: call read_skill again with from: ${DEFAULT_READ_CHARS}\\.\\]$`));
  assert.ok(p1.length < MAX_RESULT_CHARS && !p1.includes('[Cut here'), 'a slice with its head is under the cap');
  const p2 = await run('read_skill', { skillId: S_DD, from: DEFAULT_READ_CHARS, chars: 500 });
  assert.match(p2, new RegExp(`Characters ${(DEFAULT_READ_CHARS + 1).toLocaleString('en')}–${(DEFAULT_READ_CHARS + 500).toLocaleString('en')} of `));
  assert.ok(p2.includes(`\n\nINSTRUCTIONS:\n\n${longInstructions.slice(DEFAULT_READ_CHARS, DEFAULT_READ_CHARS + 500)}\n\n[The instructions continue: call read_skill again with from: ${DEFAULT_READ_CHARS + 500}.]`));
  const big = await run('read_skill', { skillId: S_DD, chars: MAX_READ_CHARS * 5 });
  assert.match(big, new RegExp(`Characters 1–${MAX_READ_CHARS.toLocaleString('en')} of `), 'chars is capped at MAX_READ_CHARS');
  const lastFrom = Math.floor(longInstructions.length / 1000) * 1000;
  const last = await run('read_skill', { skillId: S_DD, from: lastFrom });
  assert.match(last, /\n\n\[End of the instructions\.\]$/);
  assert.equal(await run('read_skill', { skillId: S_DD, from: longInstructions.length + 10 }), `The firm's skill "akla-dd-format" is ${longInstructions.length.toLocaleString('en')} characters long; there is nothing at ${(longInstructions.length + 10).toLocaleString('en')}.`);
});

test('read_skill: a Hub-written skill, a pasted SKILL.md shown without its front matter, an empty one, and the refusals', async () => {
  const { run } = tools({ hubUrl: 'https://hub.test' });
  const memo = await run('read_skill', { skillId: S_MEMO });
  assert.equal(memo, [
    'The firm\'s skill "Notes memo", written in the Hub, added 16 Sept 2026; produces a document (a memo or draft the Hub saves as Word).',
    'What it is for: A short "Notes On" memo in house format.',
    'Open in Hub: https://hub.test/ai',
    'Characters 1–93 of 93.',
    '',
    'INSTRUCTIONS:',
    '',
    'Write a tight memo: what the document does, the handful of things that matter, what to watch.',
    '',
    '[End of the instructions.]',
  ].join('\n'));
  const pasted = await run('read_skill', { skillId: S_PASTED });
  assert.match(pasted, /^The firm's skill "Pasted skill", written in the Hub, added 18 Sept 2026; answers in the chat\.\nOpen in Hub: /, 'no description line without one, no name without a person');
  assert.match(pasted, /\n\nINSTRUCTIONS:\n\nThe body after the front matter\.\n\n\[End of the instructions\.\]$/);
  assert.doesNotMatch(pasted, /pasted-skill|Folded over/, 'the front matter is not shown');
  assert.equal(await run('read_skill', { skillId: S_EMPTY }), 'The firm\'s skill "Empty skill", written in the Hub, by Rayyan Islam, added 10 Oct 2026; answers in the chat.\nWhat it is for: Nothing in it yet.\nOpen in Hub: https://hub.test/ai\n\nThe skill holds no instructions text.');
  await assert.rejects(run('read_skill', { skillId: S_NONE }), /^Error: There is no skill with that id\. list_skills gives them\.$/);
  await assert.rejects(run('read_skill', { skillId: 'akla-daily-agenda' }), /^Error: skillId must be a skill id \(a UUID\)\. list_skills gives them\.$/);
  await assert.rejects(run('read_skill', {}), /skillId must be a skill id/);
  const broken = tools({}, fixtures(), { ai_skills: 'timeout' });
  await assert.rejects(broken.run('read_skill', { skillId: S_MEMO }), /^Error: Could not read the skill: timeout$/);
});

test('read_skill names up to MAX_FILES_SHOWN files and counts the rest', async () => {
  const files = Array.from({ length: MAX_FILES_SHOWN + 7 }, (_, i) => ({ path: `big/references/ref-${String(i).padStart(2, '0')}.md`, size: 10 }));
  const row = { ...fixtures().ai_skills[0], skill_files: [{ path: 'big/SKILL.md', size: 1 }, ...files] };
  const { run } = tools({}, { ai_skills: [row], profiles: [] });
  const out = await run('read_skill', { skillId: row.id });
  assert.match(out, new RegExp(`\\nFiles in the skill \\(${MAX_FILES_SHOWN + 7}; they run only in the Hub[^\\n]+\\): references/ref-00\\.md, [^\\n]+references/ref-${MAX_FILES_SHOWN - 1}\\.md, and 7 more\\.\\n`));
  assert.doesNotMatch(out, new RegExp(`ref-${MAX_FILES_SHOWN}\\.md`));
});
