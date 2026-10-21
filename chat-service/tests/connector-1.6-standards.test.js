// The firm's standards in the connector (connector/tools/standards.js):
// list_document_types says which types have a Word standard and a drafting
// questionnaire, read_standard reads a standard's text in slices with its
// format rules, and get_drafting_decisions prints the questionnaire of
// questionnaire.js as numbered decisions with options, conditions and the
// legal basis. The database is stubbed; the questionnaire is the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubTools, loadToolModules, BUILT_IN_TOOL_NAMES, MAX_RESULT_CHARS, MAX_READ_CHARS } from '../connector/tools.js';
import { DEFAULT_HUB_URL } from '../connector/hubLinks.js';
import standards, { plainTextOf, standardLink, openStandard, conditionsOf, decisionText, decisionsText, DECISIONS_PAGE_CHARS, TYPES_PER_PAGE } from '../connector/tools/standards.js';
import { QUESTIONNAIRES } from '../questionnaire.js';

const T_RFP = '2179ed80-e868-424f-9c72-29d5c6d88648';
const T_CA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T_NDA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T_SEEDED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T_NONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RFP = QUESTIONNAIRES.rfp_federal_ppp;

// A Supabase client over plain arrays: eq/order/limit apply to the table's
// rows; embedded rows are already on them.
function fakeSupabase(tables) {
  const calls = [];
  const chain = (table) => {
    let rows = [...(tables[table] ?? [])];
    let single = false;
    const q = {
      select(cols) { calls.push(`${table}: ${cols}`); return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      order(col, { ascending = true } = {}) { rows.sort((a, b) => ((a[col] ?? '') > (b[col] ?? '') ? 1 : (a[col] ?? '') < (b[col] ?? '') ? -1 : 0) * (ascending ? 1 : -1)); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      maybeSingle() { single = true; return q; },
      then(ok, bad) { return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(ok, bad); },
    };
    return q;
  };
  return { calls, from: chain };
}

const longStandard = Array.from({ length: 220 }, (_, i) => `${i + 1}. The Concessionaire shall maintain the Project Facilities in accordance with the Maintenance Manual and good industry practice throughout the Operations Period.`).join('\n\n');

function fixtures() {
  const rfpStandard = { document_type_id: T_RFP, filename: 'RFP Volume I standard.docx', storage_path: `standards/${T_RFP}/1-RFP.docx`, updated_at: '2026-09-18T08:00:00Z', content_html: 'VOLUME I\n\nINSTRUCTIONS TO BIDDERS\n\n1. The Agency invites bids.', format_rules: 'Clauses are numbered 1, 1.1, 1.1.1; headings in bold capitals; body Arial 11.' };
  const caStandard = { document_type_id: T_CA, filename: 'Standard Concession Agreement [AKLA].docx', storage_path: `standards/${T_CA}/1-CA.docx`, updated_at: '2026-10-01T08:00:00Z', content_html: longStandard, format_rules: null };
  const seeded = { document_type_id: T_SEEDED, filename: null, storage_path: null, updated_at: '2026-08-28T08:00:00Z', content_html: '<h1>Non-Disclosure Agreement</h1><p>This Agreement is made between &quot;the Disclosing Party&quot; &amp; the Receiving Party.</p><ul><li>Confidential Information</li><li>Permitted Purpose</li></ul>', format_rules: null };
  const types = [
    { id: T_RFP, name: 'RFP Volume I', category: 'Procurement', questionnaire: 'rfp_federal_ppp' },
    { id: T_CA, name: 'Concession Agreement', category: 'Infrastructure', questionnaire: null },
    { id: T_NDA, name: 'Non-Disclosure Agreement', category: 'Corporate', questionnaire: null },
    { id: T_SEEDED, name: 'Seeded Agreement', category: 'Corporate', questionnaire: 'unknown_key' },
    { id: T_NONE, name: 'Board Resolution', category: null, questionnaire: null },
  ];
  const standards = { [T_RFP]: rfpStandard, [T_CA]: caStandard, [T_SEEDED]: seeded };
  return {
    document_types: types.map((t) => ({ ...t, standard: standards[t.id] ?? null })),
    document_type_templates: Object.values(standards).map((s) => ({ ...s, document_type: types.find((t) => t.id === s.document_type_id) })),
  };
}

function tools(extra = {}) {
  const supabase = fakeSupabase(fixtures());
  const list = createHubTools({ supabase, voyageKey: 'v', log: () => {}, modules: [standards], ...extra });
  const byName = Object.fromEntries(list.map((t) => [t.name, t]));
  return { supabase, list, byName, run: (name, input) => byName[name].run(input, { userId: 'u1' }) };
}

test('the three standards tools register after the built-in eight, through the directory and on their own', async () => {
  const { list } = tools();
  assert.deepEqual(list.map((t) => t.name), [...BUILT_IN_TOOL_NAMES, 'list_document_types', 'read_standard', 'get_drafting_decisions']);
  for (const t of list.slice(BUILT_IN_TOOL_NAMES.length)) {
    assert.ok(t.title && t.description.length > 80, `${t.name} describes itself for a lawyer's Claude`);
    assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name} has an input schema`);
  }
  const loaded = await loadToolModules();
  assert.ok(loaded.some((m) => m.file === 'standards.js'), 'connector.js loads it with the rest');
  const names = createHubTools({ supabase: { from() { throw new Error('no db'); } }, voyageKey: 'v', log: () => {}, modules: loaded }).map((t) => t.name);
  for (const n of ['list_document_types', 'read_standard', 'get_drafting_decisions']) assert.ok(names.includes(n), `${n} is registered from the directory`);
  assert.equal(new Set(names).size, names.length, 'no name twice');
});

test('plainTextOf keeps extracted text as it is and turns a seeded HTML standard into paragraphs', () => {
  assert.equal(plainTextOf('VOLUME I\r\n\r\n1. The Agency   invites bids.\n\n\n\n2. Next.'), 'VOLUME I\n\n1. The Agency invites bids.\n\n2. Next.');
  assert.equal(plainTextOf('<h1>Title</h1><p>Para &amp; one &lt;b&gt; &#8220;quoted&#8221;</p><ul><li>a</li><li>b</li></ul><table><tr><td>1</td><td>2</td></tr></table><p>x<br>y</p><img src="data:x"><script>bad()</script>'),
    'Title\n\nPara & one <b> “quoted”\n\n- a\n- b\n\n1\t2\n\nx\ny\n\n[image]');
  assert.equal(plainTextOf('<p>&amp;lt; stays as the text &lt;</p>'), '&lt; stays as the text <', 'entities decode once');
  assert.equal(plainTextOf('&amp; stays in extracted text'), '&amp; stays in extracted text', 'no tag, no decoding');
  assert.equal(plainTextOf(null), '');
});

test('a standard links to its page on the Hub', () => {
  assert.equal(standardLink(T_CA), `${DEFAULT_HUB_URL}/precedent-library/standardize/${T_CA}`);
  assert.equal(openStandard(T_CA, 'https://hub.test/'), `Open in Hub: https://hub.test/precedent-library/standardize/${T_CA}`);
  assert.throws(() => standardLink(''), /needs a document type id/);
});

test('list_document_types groups the types by category with ids, standards, questionnaires and Hub links', async () => {
  const { run, supabase } = tools({ hubUrl: 'https://hub.test' });
  const out = await run('list_document_types', {});
  // The Concession Agreement and the Board Resolution have their decisions from the data files, by name (questionnaire.js questionnaireFor).
  assert.match(out, /^5 document types on the Hub: 3 with a standard, 3 with a drafting questionnaire\. read_standard reads a standard's text; get_drafting_decisions lists a type's drafting decisions\./);
  // Categories in alphabetical order, a type without one under Other.
  const heads = [...out.matchAll(/^[A-Z][A-Z ]+$/gm)].map((m) => m[0]);
  assert.deepEqual(heads, ['CORPORATE', 'INFRASTRUCTURE', 'OTHER', 'PROCUREMENT']);
  assert.match(out, new RegExp(`- RFP Volume I\\n  documentTypeId: ${T_RFP}\\n  Word standard: RFP Volume I standard\\.docx, updated 18 Sept 2026\\n  Open in Hub: https://hub\\.test/precedent-library/standardize/${T_RFP}\\n  drafting questionnaire: ${RFP.questions.length} decisions \\(get_drafting_decisions\\)`));
  assert.match(out, new RegExp(`- Concession Agreement\\n  documentTypeId: ${T_CA}\\n  Word standard: Standard Concession Agreement \\[AKLA\\]\\.docx, updated 1 Oct 2026\\n  Open in Hub: `));
  // A type with a style sheet and a clause list says so, and where they are.
  assert.match(out, /- Concession Agreement\n[\s\S]*?  drafting questionnaire: \d+ decisions \(get_drafting_decisions\)\n  the firm's rules for it: its own style sheet \("concession-agreement", on top of the firm-wide one: get_firm_rules with this documentTypeId\); a clause list of \d+ parts in the firm's order[^\n]*open_standard_for_filling lists it[^\n]*get_clause_examples/);
  assert.doesNotMatch(out, /Non-Disclosure Agreement\n[^-]*the firm's rules for it/, 'a kind with neither has no such line');
  assert.match(out, new RegExp(`- Non-Disclosure Agreement\\n  documentTypeId: ${T_NDA}\\n  no standard yet\\n`));
  assert.match(out, /- Seeded Agreement\n  documentTypeId: [^\n]+\n  standard text \(no Word file\), updated 28 Aug 2026\n  Open in Hub: /);
  assert.doesNotMatch(out, /Seeded Agreement[\s\S]{0,300}drafting questionnaire/, 'a questionnaire key the service does not know is not offered');
  assert.match(out, /OTHER\n- Board Resolution\n/);
  assert.equal((out.match(/Open in Hub:/g) ?? []).length, 3, 'one link per standard, none for a type without one');
  assert.equal(supabase.calls.length, 1, 'one query');
  assert.match(supabase.calls[0], /^document_types: id, name, category, questionnaire, skeleton, decisions, standard:document_type_templates\(/);
  assert.match(out, /\n\n\[End of the list\.\]$/);
  const empty = createHubTools({ supabase: fakeSupabase({}), voyageKey: 'v', log: () => {}, modules: [standards] }).find((t) => t.name === 'list_document_types');
  assert.equal(await empty.run({}, { userId: 'u1' }), 'The Hub has no document types yet.');
});

test('list_document_types pages a long list, repeating the category on a new page, and says where it continues', async () => {
  const types = Array.from({ length: TYPES_PER_PAGE + 50 }, (_, i) => ({ id: `t${i}`, name: `Type ${String(i).padStart(3, '0')}`, category: i % 2 ? 'Corporate' : 'Infrastructure', questionnaire: null, standard: { filename: `Standard ${i}.docx`, storage_path: `standards/t${i}/1.docx`, updated_at: '2026-09-18T08:00:00Z' } }));
  const list = createHubTools({ supabase: fakeSupabase({ document_types: types }), voyageKey: 'v', log: () => {}, hubUrl: 'https://hub.test', modules: [standards] });
  const tool = list.find((t) => t.name === 'list_document_types');
  assert.ok(tool.inputSchema.page, 'pages with page');
  const run = (input) => tool.run(input, { userId: 'u1' });
  const page1 = await run({});
  assert.match(page1, /^150 document types on the Hub: 150 with a standard, 0 with a drafting questionnaire \(page 1 of 2\)\. read_standard reads/);
  assert.equal((page1.match(/documentTypeId:/g) ?? []).length, TYPES_PER_PAGE);
  assert.match(page1, /\n\nCORPORATE\n- Type 001\n/);
  assert.match(page1, /\n\nINFRASTRUCTURE\n- Type 000\n/);
  assert.match(page1, /\[The list continues: call list_document_types again with page: 2\.\]$/);
  assert.ok(page1.length < MAX_RESULT_CHARS && !page1.includes('[Cut here'), `page of ${page1.length} chars is never cut`);
  const page2 = await run({ page: 2 });
  assert.equal((page2.match(/documentTypeId:/g) ?? []).length, 50);
  assert.match(page2, /\(page 2 of 2\)\.[^\n]*\n\nINFRASTRUCTURE\n- Type 050\n/, 'the category heads its types again');
  assert.doesNotMatch(page2, /CORPORATE/);
  assert.match(page2, /\[End of the list\.\]$/);
  assert.equal(await run({ page: 3 }), 'The Hub has 150 document types, on 2 pages; there is no page 3.');
});

test('read_standard returns the text in slices with the format rules, the Hub link and where to continue', async () => {
  const { run } = tools({ hubUrl: 'https://hub.test' });
  const first = await run('read_standard', { documentTypeId: T_RFP });
  assert.match(first, new RegExp(`^The firm's standard for RFP Volume I \\(RFP Volume I standard\\.docx, a Word file\\), updated 18 Sept 2026 — characters 1–62 of 62\\.\\nThis type has a drafting questionnaire: get_drafting_decisions lists its decisions\\.\\nThe firm's rules for it: its own style sheet \\("rfp", on top of the firm-wide one: get_firm_rules with this documentTypeId\\); get_clause_examples gives the firm's own versions of a clause\\.\\nOpen in Hub: https://hub\\.test/precedent-library/standardize/${T_RFP}\\n\\nFORMAT RULES \\(how the Word file is laid out; a draft of this type follows them\\):\\nClauses are numbered 1, 1\\.1, 1\\.1\\.1; headings in bold capitals; body Arial 11\\.\\n\\nTEXT:\\n\\nVOLUME I\\n\\nINSTRUCTIONS TO BIDDERS\\n\\n1\\. The Agency invites bids\\.\\n\\n\\[End of the standard\\.\\]$`));

  // A long standard comes in slices; no rules line when there are none.
  const a = await run('read_standard', { documentTypeId: T_CA, chars: 5000 });
  assert.match(a, /^The firm's standard for Concession Agreement \(Standard Concession Agreement \[AKLA\]\.docx, a Word file\), updated 1 Oct 2026 — characters 1–5,000 of [\d,]+\.\nThis type has a drafting questionnaire: get_drafting_decisions lists its decisions\.\nThe firm's rules for it: its own style sheet \("concession-agreement"[^\n]*a clause list of \d+ parts[^\n]*\nOpen in Hub: /);
  assert.doesNotMatch(a, /FORMAT RULES/);
  assert.match(a, /\n\n\[The standard continues: call read_standard again with from: 5000\.\]$/);
  const body = a.slice(a.indexOf('TEXT:\n\n') + 7, a.lastIndexOf('\n\n[The standard continues'));
  assert.equal(body, longStandard.slice(0, 5000));
  const b = await run('read_standard', { documentTypeId: T_CA, from: 5000, chars: 5000 });
  assert.match(b, /characters 5,001–10,000 of/);
  assert.equal(b.slice(b.indexOf('TEXT:\n\n') + 7, b.lastIndexOf('\n\n[The standard continues')), longStandard.slice(5000, 10000));
  const last = await run('read_standard', { documentTypeId: T_CA, from: longStandard.length - 10 });
  assert.match(last, /\[End of the standard\.\]$/);
  assert.match(await run('read_standard', { documentTypeId: T_CA, from: longStandard.length + 5 }), /is [\d,]+ characters long; there is nothing at [\d,]+\.$/);
  // The slice never exceeds the read cap, whatever chars asks.
  const big = await run('read_standard', { documentTypeId: T_CA, chars: 1_000_000 });
  assert.match(big, new RegExp(`characters 1–${MAX_READ_CHARS.toLocaleString('en')} of`));
  assert.ok(big.length < MAX_RESULT_CHARS && !big.includes('[Cut here'));

  // A seeded standard is HTML in the row and plain text to Claude.
  const seeded = await run('read_standard', { documentTypeId: T_SEEDED });
  assert.match(seeded, /^The firm's standard for Seeded Agreement, updated 28 Aug 2026 — characters 1–\d+ of \d+\./);
  assert.match(seeded, /TEXT:\n\nNon-Disclosure Agreement\n\nThis Agreement is made between "the Disclosing Party" & the Receiving Party\.\n\n- Confidential Information\n- Permitted Purpose\n\n\[End of the standard\.\]$/);
});

test('read_standard says when a type has no standard, and refuses an id that is not a type', async () => {
  const { run } = tools();
  assert.equal(await run('read_standard', { documentTypeId: T_NDA }), 'Non-Disclosure Agreement has no standard yet. list_document_types shows which types have one; search_precedents finds the firm\'s past documents of this type.');
  await assert.rejects(run('read_standard', { documentTypeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }), /There is no document type with that id\. list_document_types gives them\./);
  await assert.rejects(run('read_standard', { documentTypeId: 'not-a-uuid' }), /documentTypeId must be a document type id \(a UUID\)\. list_document_types gives them\./);
  await assert.rejects(run('get_drafting_decisions', {}), /documentTypeId must be a document type id/);
  await assert.rejects(run('get_drafting_decisions', { documentTypeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }), /There is no document type with that id/);
});

test('conditionsOf reads the questionnaire\'s rules off its functions, in words', () => {
  const q = (id) => RFP.questions.find((x) => x.id === id);
  assert.deepEqual(conditionsOf(RFP, q('modality')), []);
  assert.deepEqual(conditionsOf(RFP, q('approval_chain')), ['Settled as Retain the full chain when Qualified / non-Qualified Project is Qualified Project; do not ask it then.']);
  assert.deepEqual(conditionsOf(RFP, q('pcp_step')), ['Not asked when Regulatory approval chain is Delete the approval chain.']);
  assert.deepEqual(conditionsOf(RFP, q('financing_mix')), [
    'Asked only when Primary source of financing is Commercial debt + sponsor equity or Multilateral/DFI debt + sponsor equity.',
    'Equity + commercial debt + Government support is not offered when Federal Government support is No Government support.',
  ]);
  assert.deepEqual(conditionsOf(RFP, q('revenue_sharing')), ['Settled as No revenue sharing when Revenue / compensation structure is Availability payments, Shadow toll, Annuity / hybrid annuity model (HAM) or Government payment for use / capacity charge; do not ask it then.']);
  const support = conditionsOf(RFP, q('support'));
  assert.ok(support.includes('Project Development Facility (PDF) is not offered when Qualified / non-Qualified Project is Non-Qualified Project.'));
  assert.ok(support.includes('Minimum revenue guarantee (MRG) is not offered when Revenue / compensation structure is Availability payments, Shadow toll, Annuity / hybrid annuity model (HAM) or Government payment for use / capacity charge.'));
  assert.equal(support.at(-1), 'No Government support cannot be combined with another option.');
  assert.deepEqual(conditionsOf(RFP, q('revenue_basis')), [
    'Settled as Construction revenue when Technical evaluation category is Construction Capability; do not ask it then.',
    'Settled as Sector-specific revenue when Technical evaluation category is Delivery Capability; do not ask it then.',
  ]);
  // Every rule in the questionnaire is reported somewhere: a question with a function has at least one line.
  for (const x of RFP.questions) if (x.appliesWhen || x.auto || x.filter || x.exclusive?.length) assert.ok(conditionsOf(RFP, x).length > 0, `${x.id} has its rules in words`);
});

test('get_drafting_decisions prints the RFP questionnaire as numbered decisions with options, basis and rules', async () => {
  const { run } = tools({ hubUrl: 'https://hub.test' });
  const out = await run('get_drafting_decisions', { documentTypeId: T_RFP });
  assert.equal(out, decisionsText(RFP, { type: { id: T_RFP, name: 'RFP Volume I', questionnaire: 'rfp_federal_ppp' }, standard: fixtures().document_type_templates[0], hubUrl: 'https://hub.test' }));
  assert.match(out, new RegExp(`^Federal PPP RFP — Volume I drafting decisions: the ${RFP.questions.length} drafting decisions the firm's questionnaire asks before RFP Volume I is drafted from the Word standard, in the order the Hub asks them\\.`));
  assert.match(out, /Ask the lawyer each decision in prose, one at a time, in this order; skip one an earlier answer settles, and do not offer an option an earlier answer rules out\. Carry the answers in this conversation: nothing is kept on the Hub\. The Hub asks first: PPP delivery modality\./);
  assert.match(out, /\nThe firm's Word standard for this type is RFP Volume I standard\.docx; in the Hub each answer is applied to it as tracked changes\. read_standard reads its text\.\nOpen in Hub: https:\/\/hub\.test\/precedent-library\/standardize\//);
  assert.match(out, /\n\nPROJECT STRUCTURE\n\n1\. PPP delivery modality\n   Question: Which PPP delivery modality will the Project use\?\n   Where it sits: Glossary "Project" definition/);
  assert.match(out, /\n   Basis: Bracketed alternative in the RFP; modality menu per standard PPP taxonomy and ADB's Pakistan PPP Landscape note\.\n   Choose one:\n   - Build-Operate-Transfer \(BOT\)\n   - Build-Own-Operate-Transfer \(BOOT\)\n   - Design-Build-Finance-Operate-Transfer \(DBFOT\) — The RFP's current default\n/);
  assert.match(out, /\n\nSTATUS AND APPROVALS\n\n3\. Qualified \/ non-Qualified Project\n   Question: Is this a Qualified Project under the P3A Act\?\n/);
  assert.match(out, /\n4\. Regulatory approval chain\n[\s\S]*?\n   Settled as Retain the full chain when Qualified \/ non-Qualified Project is Qualified Project; do not ask it then\.\n/);
  assert.match(out, /\n   Choose any that apply:\n   - Project Development Facility \(PDF\) — Section 12, P3A Act\n/);
  assert.match(out, /No Government support cannot be combined with another option\./);
  // Every decision, in questionnaire order, each section heading once.
  const numbers = [...out.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, RFP.questions.map((_, i) => i + 1));
  const sections = [...new Set(RFP.questions.map((x) => x.section))];
  for (const s of sections) assert.equal((out.match(new RegExp(`^${s.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm')) ?? []).length, 1, `${s} heads its decisions once`);
  assert.match(out, /\n\nWHEN THE DECISIONS ARE MADE: That completes the drafting decisions\. What remains are the project's own facts/);
  assert.match(out, /\n\n\[End of the decisions\.\]$/);
  assert.ok(out.length < MAX_RESULT_CHARS && !out.includes('[Cut here'), 'the whole questionnaire fits one result');
  // Starting part way through.
  const later = await run('get_drafting_decisions', { documentTypeId: T_RFP, from: 29 });
  assert.doesNotMatch(later, /\n1\. PPP delivery modality/);
  assert.match(later, /\n29\. [^\n]+\n[\s\S]*\n30\. [^\n]+\n[\s\S]*\[End of the decisions\.\]$/);
  assert.match(await run('get_drafting_decisions', { documentTypeId: T_RFP, from: 999 }), new RegExp(`\\n${RFP.questions.length}\\. `), 'a number past the end gives the last decision');
});

test('get_drafting_decisions says when a type has no questionnaire, or no Word standard', async () => {
  const { run } = tools();
  assert.equal(await run('get_drafting_decisions', { documentTypeId: T_NDA }), 'Non-Disclosure Agreement has no drafting questionnaire. list_document_types shows which types have one; a draft of this type starts from read_standard and the facts the lawyer gives.');
  // A type with no questionnaire key has the decisions of its data file, by name (questionnaire.js questionnaireFor).
  assert.match(await run('get_drafting_decisions', { documentTypeId: T_CA }), /^Concession agreement drafting decisions: the \d+ drafting decisions the firm's questionnaire asks before Concession Agreement is drafted/);
  assert.match(await run('get_drafting_decisions', { documentTypeId: T_SEEDED }), /^Seeded Agreement has no drafting questionnaire\./, 'a key the service does not know counts as none');
  // A type with the questionnaire but no .docx standard: the decisions still come, with the note the Hub gives.
  const noFile = decisionsText(RFP, { type: { id: T_RFP, name: 'RFP Volume I' }, standard: { filename: null, storage_path: null }, hubUrl: 'https://hub.test' });
  assert.match(noFile, /\nThis type has no Word standard yet, so the Hub drafts it the ordinary way; the decisions still apply\.\nOpen in Hub: /);
});

test('a questionnaire longer than a page comes in pages that say where to continue, never over the cap', async () => {
  const filler = 'The option, explained at length so that the questionnaire outgrows one page of the tool. '.repeat(20);
  const big = {
    key: 'big', name: 'A long questionnaire', closing: 'That is all.',
    questions: Array.from({ length: 40 }, (_, i) => ({ id: `q${i + 1}`, section: i < 20 ? 'First half' : 'Second half', title: `Decision ${i + 1}`, question: `Question ${i + 1}?`, location: 'Clause 1', basis: 'Rule 1.', options: [{ id: 'a', label: 'Option A', hint: filler }, { id: 'b', label: 'Option B' }] })),
  };
  const type = { id: T_RFP, name: 'Long Type' };
  const pages = [];
  for (let from = 1; ;) {
    const page = decisionsText(big, { type, standard: null, hubUrl: 'https://hub.test', from });
    pages.push(page);
    assert.ok(page.length <= DECISIONS_PAGE_CHARS + 400 && page.length < MAX_RESULT_CHARS, `page from ${from} is ${page.length} chars`);
    const next = page.match(/\[The decisions continue: call get_drafting_decisions again with from: (\d+)\.\]$/);
    if (!next) { assert.match(page, /That is all\.\n\n\[End of the decisions\.\]$/); break; }
    assert.ok(Number(next[1]) > from);
    from = Number(next[1]);
  }
  assert.ok(pages.length >= 2, `${pages.length} pages`);
  const numbers = pages.flatMap((p) => [...p.matchAll(/^(\d+)\. Decision/gm)].map((m) => Number(m[1])));
  assert.deepEqual(numbers, big.questions.map((_, i) => i + 1), 'every decision once, in order, across the pages');
  assert.match(pages[0], /\nFIRST HALF\n\n1\. Decision 1\n/);
  assert.doesNotMatch(pages.at(-1), /That completes/);
  assert.equal(decisionText(big, big.questions[0], 1).split('\n')[0], '1. Decision 1');
});
