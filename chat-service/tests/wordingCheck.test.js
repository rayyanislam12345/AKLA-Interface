// The wording check (proofCheck.js runWordingCheck) and the style sheets it
// reads (styleSheets/, firmRules.js styleSheetText): each rule on a small
// fixture, a draft in the firm's form with nothing to report, the family
// differences, and the timing on a 4,000-paragraph agreement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runWordingCheck, wordingSummary, numberToWords, WORDING_CATEGORIES, runProofCheck } from '../proofCheck.js';
import { styleSheetFor, styleSheetKeyFor, FAMILY_KEYS, FAMILY_SHEETS, CORE, TYPE_STYLE_SHEETS, mergeSheets } from '../styleSheets/index.js';
import { FIRM_STYLE_CORE, styleSheetText } from '../firmRules.js';
import { extractForIndex } from '../indexing/extract.js';

const doc = (...lines) => ({ blocks: lines.map((text) => ({ text })) });
const of = (result, category) => result.items.filter((i) => i.category === category);
const PACK_TYPES = JSON.parse(readFileSync(new URL('../../scripts/drafting-packs/pack-types.json', import.meta.url), 'utf8')).packs;

const FIRM_FORM = [
  'ESCROW AGREEMENT',
  'This Escrow Agreement (this Agreement) is entered into on this [●] day of [●] (the Signing Date) at [●], Pakistan:',
  '[●], a company incorporated under the Applicable Laws, having its registered office at [●] (the Concessionaire, which expression shall, where the context so permits, be deemed to mean and include its successors-in-interest and permitted assigns);',
  '(the Government, the Concessionaire and the Escrow Agent are hereinafter collectively referred to as the Parties and each individually as a Party).',
  '1. Definitions',
  '1.1 Escrow Amount means PKR 1,000,000/- (Pakistani Rupees One Million Only), and thereafter PKR 1,000,000/-.',
  '1.2 Signing Date shall bear the meaning ascribed thereto in the preamble.',
  '2. The Appointment',
  '2.1 The Concessionaire hereby appoints the Escrow Agent, who shall act within thirty (30) days of October 19, 2026 and hold fifty percent (50%) of the Escrow Amount.',
  '2.2 The Escrow Agent shall be authorised to act in accordance with Section 2.1 (The Appointment).',
  '3. Fees',
  '3.1 The fees are set out in Section 2.2 (The Appointment).',
];

test('a draft in the firm\'s form has nothing to report; the check never blocks', () => {
  const r = runWordingCheck(doc(...FIRM_FORM), { styleSheet: 'Escrow Agreement' });
  assert.equal(r.kind, 'wording');
  assert.equal(r.blocking, false);
  assert.equal(r.style_sheet, 'escrow');
  assert.deepEqual(Object.keys(r.counts), WORDING_CATEGORIES);
  assert.deepEqual(r.items, [], JSON.stringify(r.items, null, 1));
  assert.equal(wordingSummary(r), "Wording: nothing to report against the firm's style sheet.");
});

test('defined terms: quotation marks in brackets and in the definitions are flagged, a quoted phrase is not', () => {
  const r = runWordingCheck(doc(
    'This Agreement is made between [●] (the “Agency”) and [●] (each a "Party" and together the "Parties").',
    '“Escrow Account” means the account opened under this Agreement;',
    'The words (in “writing”) include email.',
  ));
  const items = of(r, 'defined_term_form');
  assert.deepEqual(items.map((i) => i.note), [
    'Defined terms are bold in brackets without quotation marks: (the **Agency**).',
    'Defined terms are bold in brackets without quotation marks: (the **Party**).',
    'Defined terms are bold in brackets without quotation marks: (the **Parties**).',
    'In the definitions the term is bold without quotation marks: **Escrow Account** means …',
  ]);
});

test('numbers, percentages and money in words and figures; money once in words, in PKR', () => {
  const r = runWordingCheck(doc(
    'The Concessionaire shall pay within 30 days, and Section 30 days is a reference, and 50% of the price.',
    'The fee is PKR 2,500,000 and the deposit Rs. 10,000 (Rupees Ten Thousand Only).',
    'The fee of PKR 2,500,000 is repeated, and USD 1,000 (United States Dollars One Thousand Only) is fine.',
    'Payment within thirty (30) days and fifty percent (50%).',
  ));
  const notes = of(r, 'number_words').map((i) => i.note);
  assert.ok(notes.includes('Write it in words and figures: thirty (30) days.'));
  assert.ok(notes.includes('Write it in words and figures: fifty percent (50%).'));
  assert.ok(notes.includes('Write the amount in figures and words where it first appears: PKR 2,500,000/- (Pakistani Rupees Two Million Five Hundred Thousand Only).'));
  assert.ok(notes.includes('The firm writes the currency as PKR: PKR 10,000/-.'));
  assert.equal(notes.filter((n) => /2,500,000/.test(n)).length, 1, 'once per amount');
  assert.equal(notes.length, 4, notes.join('\n'));
  assert.equal(numberToWords(125), 'one hundred and twenty five');
  assert.equal(numberToWords(64200542887, { and: false }), 'sixty four billion two hundred million five hundred forty two thousand eight hundred eighty seven');
});

test('dates: October 19, 2026 — the day-month forms, ordinals, unpadded days and numeric dates are flagged; the preamble formula is not', () => {
  const r = runWordingCheck(doc(
    'Dated 19 October 2026 and 5th March, 2025 and October 9, 2026 and October 19th, 2026.',
    'Signed on 19/10/2026, on 2026-10-19 and on Oct 19, 2026.',
    'entered into on this 19th day of October, 2026 at [●], Pakistan, and October 19, 2026 is fine.',
  ));
  assert.deepEqual(of(r, 'date_format').map((i) => i.note), [
    'Write dates as October 19, 2026 (month, day, year).',
    'Write dates as March 05, 2025 (month, day, year).',
    'Write dates as October 09, 2026 (month, day, year).',
    'Write dates as October 19, 2026 (month, day, year).',
    'Write dates as October 19, 2026 (month, day, year).',
    'Write dates as October 19, 2026 (month, day, year).',
    'Write dates as October 19, 2026 (month, day, year).',
  ]);
});

test('placeholders: [●] is the firm\'s; [•], [ ], [____] and bare dots are not; a bracketed description is allowed', () => {
  const r = runWordingCheck(doc('The Agent is [●] at [•], [ ] and [____], under the [applicable PPP law]; the fee is ● only.', '• a bullet is fine'));
  assert.equal(of(r, 'placeholder_style').length, 4);
  assert.ok(of(r, 'placeholder_style').every((i) => i.note === "The firm's placeholder is [●]."));
});

test('cross-references carry their heading, the right one, and point at something that exists', () => {
  const r = runWordingCheck(doc(
    '1. Definitions', '1.1 Words have their meaning.', '2. The Appointment', '2.1 The Agent is appointed.',
    '3. Fees', '3.1 Fees are paid under Section 2 and again under Section 2, and Section 2.1 has no heading of its own.', '3.2 See Section 2 (Fees) and Section 2.9 and Section 3 (Fees), and the Companies Act, 2017 at Section 301.',
  ), { styleSheet: 'escrow' });
  assert.deepEqual(of(r, 'cross_ref_heading').map((i) => [i.severity, i.note]), [
    ['high', 'Section 2.9 is referred to, but this document has no Section 2.9.'],
    ['medium', 'The heading in brackets, “Fees”, is not the heading of Section 2, which is “The Appointment”.'],
    ['low', 'Give the heading with the reference: Section 2 (The Appointment).'],
  ]);
  // A family that calls its provisions Sections: a "Clause" among Sections is the slip.
  const mixed = runWordingCheck(doc('1. Definitions', '1.1 Words.', '2. Fees', '2.1 Paid.', '3. Notices', '3.1 Under Section 2 (Fees) and Clause 2.1.'), { styleSheet: 'escrow' });
  assert.ok(of(mixed, 'cross_ref_heading').some((i) => i.note === 'This document calls its provisions “Section”: “Clause 2.1” should read “Section 2.1”.'));
});

test('spelling: -ize to -ise, once per word with a count; size, seize and a named Organization stay', () => {
  const r = runWordingCheck(doc('The Agent is authorized; the authorization and Authorization are needed.', 'Its size, seized goods and the World Health Organization; the program and the computer program; favor and color.'));
  const notes = of(r, 'spelling_convention').map((i) => i.note);
  assert.deepEqual(notes, [
    'British spelling: “authorised”, not “authorized”.',
    'British spelling: “authorisation”, not “authorization” (2 times).',
    'British spelling: “programme”, not “program”.',
    'British spelling: “favour”, not “favor”.',
    'British spelling: “colour”, not “color”.',
  ]);
});

test('banned phrasings: "we" in a memo, "will" for an obligation in an agreement, another firm\'s party clause; a letter may say "we"', () => {
  const memo = runWordingCheck(doc('We are of the view that our client must consent, and we note it.', 'The Firm notes “we agree” in the quoted letter.'), { styleSheet: 'Research Memo' });
  assert.deepEqual(of(memo, 'banned_phrase').map((i) => i.note), ['The firm speaks as "the Firm", never "we", "our" or "us". (3 times in this paragraph)']);
  const letter = runWordingCheck(doc('We, [●] (the Concessionaire), refer you to the following:'), { styleSheet: 'Letter / Notice' });
  assert.equal(of(letter, 'banned_phrase').length, 0);
  const agreement = runWordingCheck(doc(
    'Recitals', 'Whereas, the Parties will enter into this Agreement.',
    '2.1 The Escrow Agent will pay the Concessionaire, and it will be deemed paid.',
    '[●] (hereinafter referred to as the Bank which expression shall mean and include its assigns).',
  ), { styleSheet: 'escrow' });
  const notes = of(agreement, 'banned_phrase').map((i) => i.note);
  assert.equal(notes.filter((n) => /takes "shall"/.test(n)).length, 1);
  assert.equal(notes.filter((n) => /hereinafter referred to as/.test(n)).length, 1);
});

test('a named government or province is flagged, except where Government is defined; a nationwide law is not', () => {
  const r = runWordingCheck(doc(
    'Government means the Government of Sindh acting through its [●] Department;',
    'The Agency shall comply with the Sindh Public Private Partnership Act, 2010, the SPPRA rules and the directions of the Government of Punjab.',
    'The Company is registered under the Companies Act, 2017 with the SECP and pays tax to the FBR.',
  ));
  const items = of(r, 'government_named');
  assert.deepEqual(items.map((i) => i.text.slice(i.text.indexOf('“') + 1)).length, 3);
  assert.ok(items.some((i) => /“Sindh Public Private Partnership Act” is a province-specific/.test(i.note)));
  assert.ok(items.some((i) => /“Government of Punjab” names a government/.test(i.note)));
  assert.ok(items.some((i) => /“SPPRA”/.test(i.note)));
  assert.ok(items.every((i) => i.severity === 'medium'));
});

test('another firm\'s draft is recognised by its marks, and said once in the notes', () => {
  const r = runWordingCheck(doc(
    'THIS AGREEMENT WITNESSETH that [●] (hereinafter referred to as the "Company") and [●] (the "Bank") and [●] (the "Agent") agree.',
    '"Facility" means the loan; "Lender" means the bank;',
    'The Company will repay on 19th October, 2026 and will be authorized, organized and recognized.',
  ), { styleSheet: 'escrow' });
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /^This reads like another firm's draft \(defined terms in quotation marks, "hereinafter referred to as", "WITNESSETH", American -ize spelling/);
});

test('the style sheets: every family file loads, names its types and sources, compiles its patterns, and agrees with pack-types.json', () => {
  for (const key of FAMILY_KEYS) {
    const sheet = styleSheetFor(key);
    assert.equal(sheet.key, key);
    assert.ok(FAMILY_SHEETS[key].types.length, `${key} names its types`);
    for (const b of sheet.banned) if (b.pattern) assert.doesNotThrow(() => new RegExp(b.pattern, b.flags ?? ''), `${key} ${b.id}`);
    for (const [name, v] of Object.entries(sheet.formulae ?? {})) assert.ok(v.source?.length, `${key} formula ${name} has a source`);
    for (const [k, v] of Object.entries(FAMILY_SHEETS[key])) if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'formulae') assert.ok(v.source?.length, `${key}.${k} has a source`);
  }
  for (const p of CORE.government.patterns) assert.doesNotThrow(() => new RegExp(p, 'g'));
  for (const [pack, typeName] of Object.entries(PACK_TYPES)) {
    assert.equal(styleSheetKeyFor(typeName), pack === 'letters' ? 'letters' : pack, `${typeName} → ${pack}`);
    assert.equal(TYPE_STYLE_SHEETS[typeName], pack);
  }
  assert.equal(styleSheetKeyFor('Independent Engineer’s Agreement'), 'ie-agreement');
  assert.equal(styleSheetKeyFor('RFP Volume I'), 'rfp');
  assert.equal(styleSheetKeyFor('Concept Note'), 'memo');
  assert.equal(styleSheetKeyFor('EPC Contract'), null);
  // The decisions of 20 October: -ise, no province, arbitration asked, Government.
  assert.equal(CORE.spelling.convention, 'ise');
  assert.match(CORE.government.rule, /defined term Government/);
  for (const key of FAMILY_KEYS) assert.equal(styleSheetFor(key).spelling.convention, 'ise', key);
  assert.match(JSON.stringify(styleSheetFor('escrow').formulae.arbitration), /always asked/);
  // A family turns a firm-wide rule off; the core's lists add up with the family's.
  assert.ok(!styleSheetFor('letters').banned.some((b) => b.id === 'voice_we'));
  assert.ok(styleSheetFor('memo').banned.some((b) => b.id === 'voice_we'));
  const merged = mergeSheets({ banned: [{ id: 'a', reason: 'x' }], money: { source: ['s1'] } }, { banned: [{ id: 'a', reason: 'y' }, { id: 'b' }], money: { source: ['s2'] }, off: ['b'] });
  assert.deepEqual(merged.banned, [{ id: 'a', reason: 'y' }]);
  assert.deepEqual(merged.money.source, ['s1', 's2']);
});

test('the style sheet as prompt text: the core alone, or the core and the family, each one to two pages', () => {
  assert.match(FIRM_STYLE_CORE, /^HOW THE FIRM WRITES/);
  for (const phrase of ['(the **Concessionaire**)', 'thirty (30) days', 'PKR 1,000,000/- (Pakistani Rupees One Million Only)', 'October 19, 2026', '[●]', 'Section 2.1 (The Appointment)', 'successors-in-interest and permitted assigns', 'Government']) {
    assert.ok(FIRM_STYLE_CORE.includes(phrase), phrase);
  }
  assert.equal(styleSheetText('EPC Contract'), FIRM_STYLE_CORE);
  for (const key of FAMILY_KEYS) {
    const text = styleSheetText(key);
    assert.ok(text.startsWith(FIRM_STYLE_CORE), key);
    assert.ok(text.length > FIRM_STYLE_CORE.length + 300 && text.length < 12_000, `${key}: ${text.length}`);
  }
  assert.match(styleSheetText('Escrow Agreement'), /FOR ESCROW AGREEMENTS/);
  assert.match(styleSheetText('Letter / Notice'), /"we" is allowed here/);
  assert.match(styleSheetText('Amendment Agreement'), /shall stand deleted in its entirety and shall stand replaced/);
});

test('the wording check runs on 4,000 paragraphs of the Concession Agreement master well inside a second', { skip: !existsSync(new URL('../../firm-skills/concession-agreement/assets/Standard Concession Agreement [AKLA].docx', import.meta.url)) }, async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../../firm-skills/concession-agreement/assets/Standard Concession Agreement [AKLA].docx', import.meta.url)));
  const read = await extractForIndex(bytes, 'master.docx');
  const blocks = [...read.blocks, ...read.blocks];
  assert.ok(blocks.length >= 4000);
  runWordingCheck({ blocks }, { styleSheet: 'Concession Agreement' }); // warm
  const started = performance.now();
  const r = runWordingCheck({ blocks }, { styleSheet: 'Concession Agreement' });
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  assert.equal(r.paragraphs, blocks.length);
  // The master's own -ize spelling and its province names are found.
  assert.ok(r.counts.spelling_convention > 10);
  assert.ok(r.counts.government_named > 0);
  // The proof check still runs as before, on the same reading.
  assert.equal(runProofCheck(read).version, 1);
});
