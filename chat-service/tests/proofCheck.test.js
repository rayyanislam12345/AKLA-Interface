// The proof check: each category on small fixtures, the house number style,
// a clean document with nothing to report, and Word's own numbering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { runProofCheck, parseNumberWords, classifyBracket, toParagraphs, isTocParagraph, MAX_ITEMS_PER_CATEGORY } from '../proofCheck.js';
import { readDocx } from '../indexing/docx.js';

const doc = (...lines) => ({ blocks: lines.map((text) => ({ text })) });
const of = (result, category) => result.items.filter((i) => i.category === category);

// Five definitions so the defined-terms rules switch on, all used below.
const DEFINITIONS = [
  '1. DEFINITIONS',
  '1.1 In this Agreement:',
  '“Agency” means the Sindh Public Private Partnership Unit;',
  '“Concessionaire” means the project company;',
  '“Commercial Operations Date” means the date the Project opens to traffic;',
  '“Escrow Account” means the account opened under Clause 2.2;',
  '“Project” means the M-6 motorway;',
];
const BODY = [
  '2. THE CONCESSION',
  '2.1 The Agency grants the Concessionaire the right to operate the Project from the Commercial Operations Date for thirty (30) years.',
  '2.2 The Concessionaire shall open the Escrow Account and pay PKR 1,000,000 (Pakistani Rupees One Million only) into it.',
];

test('a clean agreement in the house style has nothing to report', () => {
  const result = runProofCheck(doc(
    'CONCESSION AGREEMENT',
    'This Agreement is made between the Agency and the Concessionaire (each a “Party” and together the “Parties”).',
    ...DEFINITIONS,
    ...BODY,
    '2.3 Each Party shall bear its own costs, subject to Clause 2.2 and Schedule 1.',
    '2.4 Any notice shall be given within sixty (60) days, or one hundred and twenty (120) days where Schedule 1 so provides, and the fee shall be twenty-five percent (25%) of Rs. 500,000/- (Rupees Five Lac only).',
    '2.5 The Concessionaire shall comply with Section 3 of the Companies Act, 2017 and the judgment reported as [2019] SCMR 123.',
    'SCHEDULE 1 – SITE',
    '1. The site is at Sukkur.',
    '2. It is shown on the plan.',
    '[*** rest of page intentionally left blank ***]',
    'Name: ______________________',
  ));
  assert.equal(result.total, 0, JSON.stringify(result.items, null, 1));
  assert.deepEqual(Object.keys(result.counts), ['placeholders', 'undefined_terms', 'unused_definitions', 'broken_references', 'number_words', 'numbering']);
  assert.deepEqual(result.notes, []);
});

test('placeholders: blanks, fields, choices, drafting notes; citations, page markers and bullets are not', () => {
  const result = runProofCheck(doc(
    '1. This Agreement is dated [●] 2026 and made with [Name of Concessionaire] at [ ].',
    '2. The [Agency/Concessionaire] shall pay the fee [Drafting Note: confirm with client]. The amount is TBD.',
    '3. The fee is PKR XX and the term is [x] years [to be attached hereto].',
    '4. Optional: [The Concessionaire may extend the term by a further five (5) years on notice.]',
    '5. As held in [2019] SCMR 123 [emphasis added].',
    '● a bullet at the start of a line is not a blank',
    'dated this ____ day of the month of signing',
  ));
  const items = of(result, 'placeholders');
  const kinds = items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['attachment', 'blank', 'blank', 'blank', 'blank', 'choice', 'drafting_note', 'drafting_note', 'fill_in', 'hand_blank', 'optional'].sort());
  assert.equal(items.filter((i) => i.severity === 'high').length, 2);
  assert.ok(items.every((i) => i.where && i.note && i.text.length <= 160 && i.find));
  const note = items.find((i) => i.kind === 'drafting_note');
  assert.equal(note.where, 'Clause 2');
  assert.match(note.note, /must come out before the draft is circulated/);
});

test('bracket classes follow check_agreement.py', () => {
  assert.equal(classifyBracket('[●]'), 'blank');
  assert.equal(classifyBracket('[ • ]'), 'blank');
  assert.equal(classifyBracket('[Date]'), 'fill_in');
  assert.equal(classifyBracket('[insert address]'), 'fill_in');
  assert.equal(classifyBracket('[30/60]'), 'choice');
  assert.equal(classifyBracket('[INCLUDE ONLY IF the Agency is a lender]'), 'drafting_note');
  assert.equal(classifyBracket('[List To Be Added]'), 'attachment');
  assert.equal(classifyBracket('[the Concessionaire shall procure the same.]'), 'optional');
  assert.equal(classifyBracket('[s]', 'Lender'), 'choice');
  assert.equal(classifyBracket('[2019]'), null);
  assert.equal(classifyBracket('[Signature page follows]'), null);
});

test('number words: the house style passes, a disagreement is caught both ways round', () => {
  const result = runProofCheck(doc(
    '1. The term is thirty (31) years.',
    '2. The fee is PKR 1,000,000 (Pakistani Rupees Ten Thousand only).',
    '3. Notice is thirty (30) days; the cap is USD 2.5 million (United States Dollars Two Million Five Hundred Thousand); the deposit is Pakistani Rupees One Million (PKR 1,000,000).',
    '4. The interest is ten percent (12%) a year, payable on the second (2nd) day.',
    '5. Within 45 (forty) days, and between thirty and forty (40) days.',
  ));
  const notes = of(result, 'number_words').map((i) => `${i.where}: ${i.note}`);
  assert.deepEqual(notes, [
    'Clause 1: The words say 30 but the figure says 31.',
    'Clause 2: The figure says 1,000,000 but the words say 10,000.',
    'Clause 4: The words say 10 but the figure says 12.',
    'Clause 5: The figure says 45 but the words say 40.',
  ]);
});

test('number words are read strictly', () => {
  assert.equal(parseNumberWords('thirty'), 30);
  assert.equal(parseNumberWords('one hundred and twenty'), 120);
  assert.equal(parseNumberWords('Two Million Five Hundred Thousand'), 2_500_000);
  assert.equal(parseNumberWords('Two Hundred Twenty-Nine'), 229);
  assert.equal(parseNumberWords('Five Lac'), 500_000);
  assert.equal(parseNumberWords('two crore fifty lakh'), 25_000_000);
  assert.equal(parseNumberWords('twenty-first'), 21);
  assert.equal(parseNumberWords('thirty and forty'), null);
  assert.equal(parseNumberWords('thousand million'), null);
  assert.equal(parseNumberWords('Rupees'), null);
});

test('definitions: unused ones, near-misses and capitalised phrases that are never defined', () => {
  const result = runProofCheck(doc(
    'This Agreement is between the Agency and the Concessionaire (each a “Party” and together the “Parties”).',
    ...DEFINITIONS,
    '“Delay Damages” means damages for late completion;',
    '“Lenders” means the banks;',
    '2. OBLIGATIONS',
    '2.1 The Agency shall hand over the Project to the Concessionaire after the Commercial Operation Date.',
    '2.2 Each Party shall pay into the Escrow Account; the Parties shall review the Escrow Account monthly and the Lender may inspect it.',
    '2.3 The Concessionaire shall insure the Project Facilities and keep the Project Facilities in repair.',
    '2.4 Payments under Clause 2.2 are made by the Federal Government of Pakistan through the State Bank of Pakistan.',
  ));
  const unused = of(result, 'unused_definitions').map((i) => i.note);
  assert.deepEqual(unused, [
    '“Commercial Operations Date” is defined but not used anywhere else in this document.',
    '“Delay Damages” is defined but not used anywhere else in this document.',
  ]);
  const undefinedTerms = of(result, 'undefined_terms');
  assert.deepEqual(undefinedTerms.map((i) => [i.severity, i.note]), [
    ['medium', '“Commercial Operation Date” looks like the defined term “Commercial Operations Date” but is spelt differently.'],
    ['low', '“Project Facilities” is used 2 times with capitals, as a defined term would be, but is not defined.'],
  ]);
  assert.equal(undefinedTerms[0].where, 'Clause 2.1');
});

test('undefined terms are not checked when the document borrows its definitions', () => {
  const result = runProofCheck(doc(
    ...DEFINITIONS,
    'Capitalised terms used but not defined in this Deed have the meanings given in the Concession Agreement.',
    '2. The Concessionaire shall keep the Project Facilities and the Project Facilities records in the Escrow Account at the Commercial Operations Date of the Project and pay the Agency.',
  ));
  assert.equal(result.counts.undefined_terms, 0);
  assert.match(result.notes[0], /take their meaning from another document/);
});

test('cross-references: a clause, schedule or sub-clause that does not exist; other documents are left alone', () => {
  const result = runProofCheck(doc(
    'This Agreement is made between the Agency and the Concessionaire.',
    '1. DEFINITIONS',
    '1.1 Terms are defined in Clause 1.2 and Clause 1.9.',
    '1.2 Headings are for convenience.',
    '2. TERMINATION',
    '2.1 Either party may terminate under Clauses 2.2 to 2.4 or Clause 2.2(c).',
    '2.2 On default:',
    '(a) the Agency may step in;',
    '(b) the Lenders may step in.',
    '2.3 Payments follow Schedule 1, Schedule 3 and Annex A, and Section 3 of the Companies Act, 2017, and Clause 9 of the Implementation Agreement, and paragraph 2 of Schedule 1.',
    '2.4 Clause 7 of this Agreement applies.',
    'SCHEDULE 1 – PAYMENTS',
    '1. Payments are monthly.',
  ));
  const notes = of(result, 'broken_references').map((i) => `${i.where}: ${i.note}`);
  assert.deepEqual(notes, [
    'Clause 1.1: Refers to Clause 1.9, but this document has no Clause 1.9.',
    'Clause 2.1: Refers to Clause 2.2(c), but this document has no Clause 2.2(c).',
    'Clause 2.3: Refers to Schedule 3, but this document has no Schedule 3.',
    'Clause 2.4: Refers to Clause 7, but this document has no Clause 7.',
  ]);
  // Annex A: the document has no annexes of its own, so it may be another document's.
  assert.ok(!notes.some((n) => /Annex/.test(n)));
});

test('numbering: a gap, a number used twice, a lettered list with a gap; nested roman lists and schedules restart cleanly', () => {
  const result = runProofCheck(doc(
    '1. DEFINITIONS',
    '1.1 First.',
    '1.3 Third.',
    '2. OBLIGATIONS',
    '2.1 The Concessionaire shall:',
    '(a) build;',
    '(i) roads;',
    '(ii) bridges;',
    '(b) operate;',
    '(d) maintain.',
    '2.2 Second.',
    '2.2 Second again.',
    'SCHEDULE 1 – SITE',
    '1. The site.',
    '2. The plan.',
  ));
  assert.deepEqual(of(result, 'numbering').map((i) => `${i.where}: ${i.note}`), [
    'Clause 1.3: Clause 1.3 follows Clause 1.1; there is no Clause 1.2.',
    'Clause 2.2: Clause 2.2 is numbered twice.',
    'Clause 2.1(d): (d) follows (b); there is no (c).',
  ]);
});

test('a wrapped PDF line that starts with a number is not taken for a clause', () => {
  const { paragraphs } = toParagraphs({ blocks: [
    { text: '1. The Concessionaire shall pay the sum of PKR', page: 1 },
    { text: '2.5 Million within thirty (30) days.', page: 1 },
    { text: '2. The Agency shall consent.', page: 1 },
  ] });
  assert.equal(paragraphs[1].info, null);
  assert.equal(paragraphs[2].key, '2');
  assert.equal(paragraphs[2].where, 'Clause 2, p. 1');
});

test('contents lines are recognised and left out of the checks', () => {
  assert.equal(isTocParagraph('1. DEFINITIONS AND INTERPRETATION .......... 3'), true);
  assert.equal(isTocParagraph('SCHEDULE 3  PAYMENT MECHANISM   45'), true);
  assert.equal(isTocParagraph('Total cost  PKR  1,000'), false);
  const result = runProofCheck(doc('CONTENTS', '1. DEFINITIONS .......... 3', '7. TERMINATION .......... 9', '1. DEFINITIONS', '1.1 Text.', '1.2 More text.'));
  assert.equal(result.counts.numbering, 0);
});

test('each category stops at 100 items and counts the rest', () => {
  const lines = Array.from({ length: 150 }, (_, i) => `${i + 1}. The value is [●].`);
  const result = runProofCheck(doc(...lines));
  assert.equal(result.counts.placeholders, 150);
  assert.equal(of(result, 'placeholders').length, MAX_ITEMS_PER_CATEGORY);
  assert.equal(result.omitted.placeholders, 50);
});

// ------------------------------------------------------------ a Word file
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text, numId, ilvl) => `<w:p>${numId ? `<w:pPr><w:numPr><w:ilvl w:val="${ilvl ?? 0}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
function wordFile(paragraphs) {
  const numbering = `<w:numbering ${W}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml': strToU8(`<w:document ${W}><w:body>${paragraphs.join('')}</w:body></w:document>`),
    'word/numbering.xml': strToU8(numbering),
    'word/styles.xml': strToU8(`<w:styles ${W}/>`),
  });
}

test('a Word file: the clause numbers Word draws are what references are checked against', () => {
  const read = readDocx(wordFile([
    p('Definitions', 1, 0),
    p('Terms have the meanings in Clause 1.2 and Clause 2.1.', 1, 1),
    p('The fee is thirty (30) days after signing.', 1, 1),
    p('Payment', 1, 0),
    p('The Agency shall pay [●] under Clause 3.1.', 1, 1),
  ]));
  assert.equal(read.blocks[1].text.startsWith('1.1 '), true);
  const result = runProofCheck(read);
  assert.deepEqual(of(result, 'broken_references').map((i) => `${i.where}: ${i.note}`), ['Clause 2.1: Refers to Clause 3.1, but this document has no Clause 3.1.']);
  assert.equal(result.counts.placeholders, 1);
  assert.equal(of(result, 'placeholders')[0].find, 'The Agency shall pay [●] under Clause 3.1.');
  assert.equal(result.counts.numbering, 0);
});
