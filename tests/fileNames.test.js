import test from 'node:test';
import assert from 'node:assert/strict';
// Node strips the types from this file itself, so the tests run against the
// very code the browser uses rather than a copy.
import {
  parseFileName,
  versionLabel,
  findMatchingDocument,
  titleSimilarity,
  compareVersionOrder,
  safeDownloadName,
  findDate,
} from '../src/lib/fileNames.ts';

const pick = (p) => ({ title: p.title, code: p.code, seq: p.seq, tags: p.tags, stage: p.stage, date: p.date, rendition: p.rendition, duplicate: p.duplicate, familyKey: p.familyKey });

test('the firm grammar: code, title, holder, stage and date', () => {
  assert.deepEqual(pick(parseFileName('KPT5.7 - USP Memorandum [For Boss Review][September 26, 2026].docx')), {
    title: 'USP Memorandum', code: 'KPT', seq: '5.7', tags: ['For Boss Review'], stage: 'For partner review',
    date: '2026-09-26', rendition: null, duplicate: false, familyKey: 'usp memorandum',
  });
  assert.deepEqual(pick(parseFileName('PI3.1 - Schedule 4 [Claude Markup][September 17, 2026].docx')), {
    title: 'Schedule 4', code: 'PI', seq: '3.1', tags: ['Claude Markup'], stage: 'AI markup',
    date: '2026-09-17', rendition: null, duplicate: false, familyKey: 'schedule 4',
  });
  assert.deepEqual(pick(parseFileName('SP3A - DD Volume III [AKLA][Second Circ Version][September 03, 2026].docx')), {
    title: 'DD Volume III', code: 'SP', seq: '3A', tags: ['AKLA', 'Second Circ Version'], stage: 'Circulated',
    date: '2026-09-03', rendition: null, duplicate: false, familyKey: 'dd volume iii',
  });
});

test('version labels are short and plain', () => {
  assert.equal(versionLabel(parseFileName('KPT5.7 - USP Memorandum [For Boss Review][September 26, 2026].docx')), 'For partner review · 26 Sep 2026');
  assert.equal(versionLabel(parseFileName('PI3.1 - Schedule 4 [Claude Markup][September 17, 2026].docx')), 'AI markup · 17 Sep 2026');
  assert.equal(versionLabel(parseFileName('SPA [Execution Version][June 4, 2026] - Clean.docx')), 'Execution · 4 Jun 2026 · Clean');
  assert.equal(versionLabel(parseFileName('Plain file.pdf')), '');
});

test('drift: bracket typos, missing brackets, squashed dates, double spaces', () => {
  const typo = parseFileName('SP3A - DD Volume III [AKLA}[Second Circ Version][September 03, 2026].docx');
  assert.deepEqual(typo.tags, ['AKLA', 'Second Circ Version']);
  assert.equal(typo.title, 'DD Volume III');

  const missing = parseFileName('Share Purchase Agreement [AKLA Draft]]June 04, 2026].docx');
  assert.equal(missing.title, 'Share Purchase Agreement');
  assert.equal(missing.date, '2026-06-04');

  const squashed = parseFileName('MM5 - Minutes of Meeting [AKLA] 30May, 2025.docx');
  assert.equal(squashed.title, 'Minutes of Meeting');
  assert.equal(squashed.date, '2025-05-30');

  const spaces = parseFileName('KPT5.7  -  USP   Memorandum  [For Boss Review] [September 26, 2026].docx');
  assert.equal(spaces.title, 'USP Memorandum');
  assert.equal(spaces.familyKey, 'usp memorandum');

  const unbracketed = parseFileName('Revised v7 - JVA June 2, 2025.docx');
  assert.equal(unbracketed.title, 'JVA');
  assert.equal(unbracketed.date, '2025-06-02');
  assert.equal(unbracketed.version, 7);
});

test('four spellings of circulation all mean Circulated', () => {
  for (const tag of ['Circulation Version', '1st Cir', '2nd Cir Ver', 'Final Circ Version', 'Curculated', 'Circulated']) {
    assert.equal(parseFileName(`NSCL8 - Term Sheet [${tag}][May 5, 2026].docx`).stage, 'Circulated', tag);
  }
});

test('stage vocabulary', () => {
  const stageOf = (tag) => parseFileName(`X1 - Lease [${tag}].docx`).stage;
  assert.equal(stageOf('WD'), 'Working draft');
  assert.equal(stageOf('First Draft'), 'Working draft');
  assert.equal(stageOf('AKLA Draft'), 'Working draft');
  assert.equal(stageOf('For Boss Review'), 'For partner review');
  assert.equal(stageOf('2nd Rec'), 'Received');
  assert.equal(stageOf('Second Received'), 'Received');
  assert.equal(stageOf('Client Comments'), 'Client comments');
  assert.equal(stageOf('Compared against AKLA First Circulated Draft'), 'Compared');
  assert.equal(stageOf('Pre-Execution Version'), 'Execution');
  assert.equal(stageOf('Execution Version'), 'Execution');
  assert.equal(stageOf('Final'), 'Final');
  assert.equal(stageOf('US Claude 1st Markup'), 'AI markup');
  assert.equal(stageOf('AKLA'), null);
  // A later stage wins when a name carries two.
  assert.equal(parseFileName('X1 - Lease [AKLA Draft][Execution Version].docx').stage, 'Execution');
});

test('renditions and browser duplicates are removed from the title', () => {
  const a = parseFileName('AM44.1 - Concession Agreement [2nd Cir Ver][March 2, 2026] - Track (2).docx');
  assert.equal(a.title, 'Concession Agreement');
  assert.equal(a.rendition, 'tracked');
  assert.equal(a.duplicate, true);
  const b = parseFileName('NED Term Sheet [Execution Version] (tracked changes) (tracked changes).docx');
  assert.equal(b.title, 'NED Term Sheet');
  assert.equal(b.rendition, 'tracked');
  assert.equal(parseFileName('SPA - Clean.docx').rendition, 'clean');
  assert.equal(parseFileName('SPA - Compared.pdf').rendition, 'compared');
  assert.equal(parseFileName('Clean - SPA [Final].docx').title, 'SPA');
  assert.equal(parseFileName('Clean - SPA [Final].docx').rendition, 'clean');
  const dup = parseFileName('KPT5.7 - USP Memorandum [For Boss Review][September 26, 2026] (1).docx');
  assert.equal(dup.duplicate, true);
  assert.equal(dup.title, 'USP Memorandum');
  assert.equal(parseFileName('Term Sheet - Copy.docx').duplicate, true);
  assert.equal(parseFileName('Term Sheet - Copy.docx').title, 'Term Sheet');
});

test('ordinals, UUIDs and plain names', () => {
  assert.equal(parseFileName('5. NED Term Sheet [AKLA].docx').title, 'NED Term Sheet');
  assert.equal(parseFileName('11. SPA.docx').title, 'SPA');
  assert.equal(parseFileName('3f2c1e4a-1b2c-4d5e-8f90-123456789abc-Lease Deed.pdf').title, 'Lease Deed');
  const plain = parseFileName('Board Resolution.pdf');
  assert.equal(plain.title, 'Board Resolution');
  assert.equal(plain.code, null);
  assert.equal(plain.extension, 'pdf');
  assert.equal(parseFileName('folder/sub/PI1 - Construction Contract.docx').title, 'Construction Contract');
  // A decimal in a title is not an extension.
  assert.equal(parseFileName('Clause 4.2 Notes').title, 'Clause 4.2 Notes');
});

test('dates in the firm’s styles; the file date is never used', () => {
  assert.equal(findDate('Jan 1, 2025').iso, '2025-01-01');
  assert.equal(findDate('Sept 9 2026').iso, '2026-09-09');
  assert.equal(findDate('30May, 2025').iso, '2025-05-30');
  assert.equal(findDate('14-03-2024').iso, '2024-03-14');
  assert.equal(findDate('14.03.24').iso, '2024-03-14');
  assert.equal(findDate('2026-01-14').iso, '2026-01-14');
  assert.equal(findDate('February 30, 2026'), null);
  assert.equal(findDate('Summary 2026'), null);
  assert.equal(parseFileName('PI3.1 - Schedule 4.docx').date, null);
});

test('matching an upload to a document already in the project', () => {
  const docs = [
    { id: 'a', title: 'USP Memorandum' },
    { id: 'b', title: 'KPT5.7 - Share Purchase Agreement [AKLA]' },
    { id: 'c', title: 'Schedule 5' },
    { id: 'd', title: 'DD Volume II' },
  ];
  assert.equal(findMatchingDocument('usp memorandum', docs).document.id, 'a');
  assert.equal(findMatchingDocument('usp memorandum', docs).exact, true);
  // A title typed in as a raw file name still matches.
  assert.equal(findMatchingDocument('share purchase agreement', docs).document.id, 'b');
  // Close: one extra word.
  const close = findMatchingDocument('share purchase agreement execution', docs);
  assert.equal(close.document.id, 'b');
  assert.equal(close.exact, false);
  // Different numbers are different documents.
  assert.equal(findMatchingDocument('schedule 4', docs), null);
  assert.equal(findMatchingDocument('dd volume iii', docs), null);
  assert.equal(titleSimilarity('civil appeal memo', 'civil appeal memo note') > 0.75, true);
});

test('versions are ordered by the name date, then the running number, then the file time', () => {
  const f = (name, lastModified) => ({ name, parsed: parseFileName(name), lastModified });
  const files = [
    f('KPT6 - USP Memorandum [Circulated][October 2, 2026].docx', 1),
    f('KPT5.7 - USP Memorandum [For Boss Review][September 26, 2026].docx', 3),
    f('KPT5.6 - USP Memorandum [WD][September 26, 2026].docx', 9),
    f('USP Memorandum.docx', Date.parse('2026-09-01T10:00:00Z')),
  ];
  const order = [...files].sort(compareVersionOrder).map((x) => x.name);
  assert.deepEqual(order, [
    'USP Memorandum.docx',
    'KPT5.6 - USP Memorandum [WD][September 26, 2026].docx',
    'KPT5.7 - USP Memorandum [For Boss Review][September 26, 2026].docx',
    'KPT6 - USP Memorandum [Circulated][October 2, 2026].docx',
  ]);
});

test('download names are safe on every computer', () => {
  assert.equal(safeDownloadName('Lease: v2 / final?.docx'), 'Lease v2 final.docx');
  assert.equal(safeDownloadName('  .hidden.pdf'), 'hidden.pdf');
});
