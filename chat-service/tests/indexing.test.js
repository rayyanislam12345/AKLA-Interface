// The index worker's reader: Word structure, chunking, the OCR decision, the
// embedding header, retries and the card parser. No network, no binaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { readDocx, formatNumber } from '../indexing/docx.js';
import {
  chunkDocument, contextualHeader, embeddingInput, estimateTokens, parseLabel, textHash,
  TARGET_MAX_TOKENS,
} from '../indexing/chunk.js';
import { extractForIndex, pageNeedsOcr, stripRunningHeads, textToBlocks, PermanentError } from '../indexing/extract.js';
import { batchInputs, embedDocuments, parseRetryAfter, retryDelayMs, withRetry, HttpError } from '../indexing/embed.js';
import { parseCardJson, cardPrompt } from '../indexing/card.js';
import { plainError } from '../indexing/pipeline.js';

// ------------------------------------------------------------------ fixtures
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const para = (text, { style, numId, ilvl } = {}) => {
  const pPr = style || numId !== undefined
    ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${numId !== undefined ? `<w:numPr>${ilvl !== undefined ? `<w:ilvl w:val="${ilvl}"/>` : ''}<w:numId w:val="${numId}"/></w:numPr>` : ''}</w:pPr>`
    : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
};
const sentence = (n, topic) => `The ${topic} obligation number ${n} applies to the Concessionaire, who shall perform it diligently, in good faith and in accordance with Good Industry Practice and the Applicable Laws.`;
const longParagraph = (topic, sentences, seed = 0) => Array.from({ length: sentences }, (_, i) => sentence(seed + i + 1, topic)).join(' ');

const styles = `<w:styles ${W}>
 <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
 <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
 <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
 <w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>
</w:styles>`;
const numbering = `<w:numbering ${W}>
 <w:abstractNum w:abstractNumId="10">
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading1"/><w:lvlText w:val="%1."/></w:lvl>
  <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading2"/><w:lvlText w:val="%1.%2"/></w:lvl>
  <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2.%3"/></w:lvl>
 </w:abstractNum>
 <w:abstractNum w:abstractNumId="20">
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/></w:lvl>
  <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="(%2)"/></w:lvl>
 </w:abstractNum>
 <w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>
 <w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num>
 <w:num w:numId="3"><w:abstractNumId w:val="20"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
</w:numbering>`;

function agreementDocx() {
  const body = [
    para('Definitions 1', { style: 'TOC1' }),
    para('Concession Agreement'),
    para('This Agreement is made between the Agency and the Concessionaire.'),
    para('Definitions and Interpretation', { style: 'Heading1' }),
    para('Definitions', { style: 'Heading2' }),
    para('In this Agreement the following words have the meanings given:'),
    para('Agency means the Sindh Public Private Partnership Unit;', { numId: 2, ilvl: 0 }),
    para('Concessionaire means the project company;', { numId: 2, ilvl: 0 }),
    para('Interpretation', { style: 'Heading2' }),
    para('Headings are for convenience only.'),
    para('Termination', { style: 'Heading1' }),
    para('Termination for Concessionaire Event of Default', { style: 'Heading2' }),
    para(longParagraph('default', 14), { numId: 1, ilvl: 2 }),
    para(longParagraph('cure', 14, 20), { numId: 1, ilvl: 2 }),
    para(longParagraph('notice', 14, 40), { numId: 1, ilvl: 2 }),
    para('Termination for convenience', { style: 'Heading2' }),
    para('The Agency may terminate this Agreement for convenience on ninety (90) days notice.'),
    // A redline: the deletion is not part of the accepted text, the insertion is.
    `<w:p><w:r><w:t xml:space="preserve">Compensation is payable </w:t></w:r><w:del w:id="1" w:author="Counterparty"><w:r><w:delText>within one year</w:delText></w:r></w:del><w:ins w:id="2" w:author="Counterparty"><w:r><w:t>within thirty (30) days</w:t></w:r></w:ins><w:r><w:t>.</w:t></w:r></w:p>`,
    para('the termination payment;', { numId: 3, ilvl: 0 }),
    para('the costs of transfer.', { numId: 3, ilvl: 0 }),
    // A text box duplicated in the VML fallback: read once.
    `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${para('Boxed note')}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${para('Boxed note')}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
  ].join('');
  const files = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(`<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`),
    'word/styles.xml': strToU8(styles),
    'word/numbering.xml': strToU8(numbering),
    'word/header1.xml': strToU8(`<w:hdr ${W}>${para('DRAFT - Subject to contract')}</w:hdr>`),
    'word/footer1.xml': strToU8(`<w:ftr ${W}>${para('Agency Initials')}</w:ftr>`),
    'word/comments.xml': strToU8(`<w:comments ${W}><w:comment w:id="0" w:author="Ali Khan Law Associates">${para('Check the cap on liquidated damages.')}</w:comment></w:comments>`),
  };
  return zipSync(files);
}

const STATUTE = `THE CONTRACT ACT, 1872

CHAPTER VI
OF THE CONSEQUENCES OF BREACH OF CONTRACT

73. Compensation for loss or damage caused by breach of contract.—When a contract has been broken, the party who suffers by such breach is entitled to receive, from the party who has broken the contract, compensation for any loss or damage caused to him thereby.
(1) ${longParagraph('compensation', 12)}
(2) ${longParagraph('remoteness', 12, 30)}
(a) such compensation is not to be given for any remote and indirect loss or damage sustained by reason of the breach.

74. Compensation for breach of contract where penalty stipulated for.—When a contract has been broken, if a sum is named in the contract as the amount to be paid in case of such breach, the party complaining of the breach is entitled to receive reasonable compensation.
(1) ${longParagraph('penalty', 12, 60)}
(2) ${longParagraph('stipulation', 12, 90)}

75. Party rightfully rescinding contract entitled to compensation.—A person who rightly rescinds a contract is entitled to compensation for any damage which he has sustained through the non-fulfilment of the contract.

CHAPTER VII
OF INDEMNITY AND GUARANTEE

124. "Contract of indemnity" defined.—A contract by which one party promises to save the other from loss caused to him is called a "contract of indemnity".`;

// Each chunk's range belongs to the blocks it was made from; overlapping
// neighbours must come from the same clause.
function assertNoCrossClauseOverlap(chunks) {
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const next = chunks[i];
    if (next.start < prev.end) {
      assert.equal(next.headingPath, prev.headingPath, `overlap between "${prev.headingPath}" and "${next.headingPath}"`);
    }
  }
}

// ------------------------------------------------------------------- tests
test('Word reader: style numbering gives clause numbers, lists their letters, TOC skipped, text boxes once', () => {
  const read = readDocx(agreementDocx());
  const texts = read.blocks.map((b) => b.text);
  assert.ok(!texts.includes('Definitions 1'), 'the contents page is navigation, not text');
  assert.ok(texts.includes('1. Definitions and Interpretation'));
  assert.ok(texts.includes('1.1 Definitions'));
  assert.ok(texts.includes('1.2 Interpretation'));
  assert.ok(texts.includes('2. Termination'));
  assert.ok(texts.includes('2.1 Termination for Concessionaire Event of Default'));
  assert.ok(texts.some((t) => t.startsWith('2.1.1 The default obligation')));
  assert.ok(texts.some((t) => t.startsWith('2.1.3 The notice obligation')));
  assert.ok(texts.includes('2.2 Termination for convenience'));
  assert.ok(texts.includes('(a) Agency means the Sindh Public Private Partnership Unit;'));
  assert.ok(texts.includes('(b) Concessionaire means the project company;'));
  // A new list instance with a startOverride restarts at (a); one sharing the abstract list would continue.
  assert.ok(texts.includes('(a) the termination payment;'));
  assert.equal(texts.filter((t) => t === 'Boxed note').length, 1);
  assert.equal(read.blocks.find((b) => b.text === '1.1 Definitions').headingLevel, 2);
});

test('Word reader: tracked changes are read as accepted, and flagged; headers, footers and comments go to side fields', () => {
  const read = readDocx(agreementDocx());
  const redline = read.blocks.find((b) => b.text.startsWith('Compensation is payable'));
  assert.equal(redline.text, 'Compensation is payable within thirty (30) days.');
  assert.equal(read.hasTrackedChanges, true);
  assert.equal(read.revisionCount, 2);
  assert.deepEqual(read.side.headers, ['DRAFT - Subject to contract']);
  assert.deepEqual(read.side.footers, ['Agency Initials']);
  assert.deepEqual(read.side.comments, [{ author: 'Ali Khan Law Associates', text: 'Check the cap on liquidated damages.' }]);
  assert.ok(!read.blocks.some((b) => /DRAFT|Initials|liquidated/.test(b.text)), 'side text stays out of the body');
});

test('Word reader: a damaged file is a plain permanent error', () => {
  assert.throws(() => readDocx(new Uint8Array([1, 2, 3, 4])), (err) => err.permanent && /damaged/.test(err.message));
});

test('number formats', () => {
  assert.equal(formatNumber(1, 'lowerLetter'), 'a');
  assert.equal(formatNumber(27, 'lowerLetter'), 'aa');
  assert.equal(formatNumber(14, 'upperRoman'), 'XIV');
  assert.equal(formatNumber(4, 'lowerRoman'), 'iv');
  assert.equal(formatNumber(3, 'bullet'), '');
});

test('clause labels', () => {
  assert.deepEqual(parseLabel('14.2 Termination for convenience'), { kind: 'clause', depth: 2, label: '14.2', rest: 'Termination for convenience' });
  assert.equal(parseLabel('14. TERMINATION').label, '14.');
  assert.equal(parseLabel('ARTICLE 5 - TERM').label, 'Article 5');
  assert.equal(parseLabel('Schedule 2 – Payment Mechanism').label, 'Schedule 2');
  assert.equal(parseLabel('CHAPTER-VI').label, 'Chapter VI');
  assert.equal(parseLabel('(a) the termination payment;').kind, 'sub');
  assert.equal(parseLabel('Schedule A attached hereto shall apply.'), null, 'a sentence that mentions a schedule is not a heading');
  assert.equal(parseLabel('12 months after the date'), null, 'a bare number is not a clause');
  assert.equal(parseLabel('2017 was a good year'), null);
});

test('chunker on an agreement: heading paths, sizes, whole paragraphs, no overlap across clauses', () => {
  const read = readDocx(agreementDocx());
  const { text, chunks } = chunkDocument(read.blocks);
  assert.ok(chunks.length >= 4);
  for (const c of chunks) {
    assert.equal(text.slice(c.start, c.end), c.content, 'content is exactly its character range');
    assert.ok(c.tokens <= TARGET_MAX_TOKENS * 1.15, `chunk ${c.index} has ${c.tokens} tokens`);
    assert.equal(c.page, null);
  }
  const defs = chunks.find((c) => c.content.includes('Sindh Public Private Partnership Unit'));
  assert.match(defs.headingPath, /^1\. Definitions and Interpretation › 1\.1 Definitions/);
  // The long clause 2.1 is split into several passages, each under its own number.
  const defaults = chunks.filter((c) => c.headingPath?.startsWith('2. Termination › 2.1 Termination for Concessionaire Event of Default'));
  assert.ok(defaults.length >= 2, 'a long clause is split');
  assert.ok(defaults.some((c) => c.headingPath.endsWith('› 2.1.1')));
  assert.ok(defaults.some((c) => c.headingPath.endsWith('› 2.1.3')));
  const convenience = chunks.find((c) => c.content.includes('terminate this Agreement for convenience'));
  assert.equal(convenience.headingPath, '2. Termination › 2.2 Termination for convenience');
  assert.ok(convenience.content.includes('within thirty (30) days'));
  // Clause 1 and clause 2 never share a passage.
  assert.ok(!chunks.some((c) => c.content.includes('Sindh Public') && c.content.includes('terminate this Agreement')));
  assertNoCrossClauseOverlap(chunks);
});

test('chunker on a statute: chapters and sections with marginal notes, long sections split under their own number', () => {
  const blocks = textToBlocks(STATUTE);
  const { text, chunks } = chunkDocument(blocks);
  for (const c of chunks) {
    assert.equal(text.slice(c.start, c.end), c.content);
    assert.ok(c.tokens <= TARGET_MAX_TOKENS * 1.15);
  }
  const s73 = chunks.filter((c) => c.headingPath === 'Chapter VI OF THE CONSEQUENCES OF BREACH OF CONTRACT › 73. Compensation for loss or damage caused by breach of contract');
  assert.ok(s73.length >= 2, `section 73 split into ${s73.length}`);
  assert.ok(s73[0].content.startsWith('73. Compensation'));
  const s74 = chunks.filter((c) => c.headingPath?.includes('› 74. Compensation for breach of contract where penalty stipulated for'));
  assert.ok(s74.length >= 1);
  assert.ok(!chunks.some((c) => c.content.includes('73. Compensation') && c.content.includes('74. Compensation')), 'two long sections never share a passage');
  const indemnity = chunks.find((c) => c.content.includes('contract of indemnity'));
  assert.match(indemnity.headingPath, /^Chapter VII OF INDEMNITY AND GUARANTEE › 124\. "Contract of indemnity" defined/);
  assertNoCrossClauseOverlap(chunks);
  // The one-paragraph overlap inside section 73 repeats its short sub-paragraph, never section 74's text.
  for (const c of s73) assert.ok(!c.content.includes('penalty stipulated'));
});

test('chunker in page mode: one passage per page, short pages merge forward, page numbers kept', () => {
  const pages = ['1. Parties\n\nThe Agency and the Concessionaire.', longParagraph('page two', 30), longParagraph('page three', 6)];
  const blocks = pages.flatMap((t, i) => textToBlocks(t, { page: i + 1 }));
  const { chunks } = chunkDocument(blocks, { mode: 'page' });
  assert.equal(chunks[0].page, 1);
  assert.ok(chunks.some((c) => c.page === 2));
  assert.ok(chunks.some((c) => c.page === 3 && c.pageEnd === 3));
  assert.ok(chunks.every((c) => c.tokens <= TARGET_MAX_TOKENS * 1.15));
  assert.ok(chunks.filter((c) => c.page <= 2 && c.pageEnd >= 2).length >= 2, 'a long page is split at paragraph breaks');
});

test('page OCR decision: under 200 visible characters is read by OCR', () => {
  assert.equal(pageNeedsOcr(''), true);
  assert.equal(pageNeedsOcr('   \n\n  \f '), true);
  assert.equal(pageNeedsOcr('Signed: ________ '.repeat(5)), true);
  assert.equal(pageNeedsOcr('x'.repeat(199)), true);
  assert.equal(pageNeedsOcr(`${'word '.repeat(50)}`), false, '200 visible characters is enough');
  assert.equal(pageNeedsOcr(' a '.repeat(500)), false, 'whitespace is not counted, letters are');
});

test('running heads and page numbers are dropped from PDF pages', () => {
  const words = ['alpha', 'bravo', 'charlie', 'delta'];
  const pages = [1, 2, 3, 4].map((n) => `THE CONTRACT ACT, 1872\n\nSection text on page ${n} about ${words[n - 1]} that matters.\n\n${n}`);
  const cleaned = stripRunningHeads(pages);
  for (const [i, p] of cleaned.entries()) {
    assert.ok(!p.includes('THE CONTRACT ACT'));
    assert.ok(p.includes(`page ${i + 1} about ${words[i]} that matters`));
    assert.ok(!/^\s*\d+\s*$/m.test(p));
  }
});

test('contextual header: document, version, type, project, then the clause and page', () => {
  assert.equal(
    contextualHeader({ title: 'Concession Agreement', versionNumber: 3, typeName: 'Concession Agreement', projectName: 'M6 Motorway', headingPath: 'Article 14 Termination › 14.2 Termination for convenience' }),
    'Document: Concession Agreement v3 (Concession Agreement, M6 Motorway) › Article 14 Termination › 14.2 Termination for convenience',
  );
  assert.equal(contextualHeader({ title: 'Site plan', versionNumber: 1, projectName: 'KPT', page: 4 }), 'Document: Site plan v1 (KPT) › p. 4');
  assert.equal(embeddingInput('Document: X v1', 'Body.'), 'Document: X v1\n\nBody.');
  assert.equal(textHash('a'), textHash('a'));
  assert.notEqual(textHash('a'), textHash('b'));
  assert.equal(estimateTokens('x'.repeat(400)), 100);
});

test('retry helper: Retry-After wins, otherwise capped exponential backoff', async () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
  const now = Date.parse('2026-10-17T10:00:00Z');
  assert.equal(parseRetryAfter('Sat, 17 Oct 2026 10:00:30 GMT', now), 30_000);
  assert.equal(retryDelayMs(1, '7'), 7000);
  assert.equal(retryDelayMs(1, '9999'), 300_000, 'a silly Retry-After is capped at five minutes');
  assert.equal(retryDelayMs(1, null, { random: () => 1 }), 1000);
  assert.equal(retryDelayMs(3, null, { random: () => 1 }), 4000);
  assert.equal(retryDelayMs(3, null, { random: () => 0 }), 2000);
  assert.equal(retryDelayMs(20, null, { random: () => 1 }), 60_000);

  const waits = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new HttpError('429', { status: 429, retryable: true, retryAfter: '2' });
    if (calls === 2) throw new HttpError('503', { status: 503, retryable: true });
    return 'ok';
  }, { wait: async (ms) => waits.push(ms), random: () => 1 });
  assert.equal(result, 'ok');
  assert.deepEqual(waits, [2000, 2000]);

  let badCalls = 0;
  await assert.rejects(withRetry(async () => { badCalls++; throw new HttpError('400', { status: 400, retryable: false }); }, { wait: async () => {} }), /400/);
  assert.equal(badCalls, 1, 'a bad request is not retried');

  let always = 0;
  await assert.rejects(withRetry(async () => { always++; throw new HttpError('500', { status: 500, retryable: true }); }, { attempts: 3, wait: async () => {} }), /500/);
  assert.equal(always, 3);
});

test('embedding: batches by size, keeps order across batches, sends truncation false, retries a 429', async () => {
  assert.deepEqual(batchInputs(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)], { maxItems: 10, maxTokens: 20, charsPerToken: 3 }), [[0, 1], [2]]);
  assert.deepEqual(batchInputs(['a', 'b', 'c'], { maxItems: 2, maxTokens: 1000 }), [[0, 1], [2]]);

  const bodies = [];
  let first = true;
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (first) {
      first = false;
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
    }
    // Answer out of order to prove the index mapping.
    const data = body.input.map((text, index) => ({ index, embedding: Array(1024).fill(text.length) })).reverse();
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const inputs = Array.from({ length: 300 }, (_, i) => 'x'.repeat(i + 1));
  const vectors = await embedDocuments(inputs, { apiKey: 'test', fetchImpl: fakeFetch });
  assert.equal(vectors.length, 300);
  vectors.forEach((v, i) => assert.equal(v[0], i + 1));
  assert.ok(bodies.every((b) => b.model === 'voyage-law-2' && b.input_type === 'document' && b.truncation === false));
  assert.ok(bodies.length >= 4, 'three batches of at most 128, plus the retried one');
});

test('card JSON parse: fences, prose, nested braces in strings, type suggestion limited to offered ids', () => {
  const answer = 'Here is the card:\n```json\n{"summary":"A concession {draft} between the Agency and X.","document_kind":"Concession Agreement","parties":[{"name":"Sindh PPP Unit","role":"Agency"},"Project Co"],"key_dates":[{"date":"2026-10-01","what":"Signing"}],"defined_terms":["Agency","Concessionaire",""],"clause_outline":["1. Definitions"],"statutes_mentioned":["Arbitration Act, 1940"],"suggested_document_type_id":"type-1"}\n```\nThanks.';
  const card = parseCardJson(answer, { documentTypeIds: ['type-1', 'type-2'] });
  assert.equal(card.summary, 'A concession {draft} between the Agency and X.');
  assert.equal(card.document_kind, 'Concession Agreement');
  assert.deepEqual(card.parties, [{ name: 'Sindh PPP Unit', role: 'Agency' }, { name: 'Project Co', role: null }]);
  assert.deepEqual(card.key_dates, [{ date: '2026-10-01', what: 'Signing' }]);
  assert.deepEqual(card.defined_terms, ['Agency', 'Concessionaire']);
  assert.deepEqual(card.statutes_mentioned, ['Arbitration Act, 1940']);
  assert.equal(card.suggested_document_type_id, 'type-1');
  assert.equal(parseCardJson(answer, { documentTypeIds: ['other'] }).suggested_document_type_id, null, 'an id that was not offered is dropped');
  assert.deepEqual(parseCardJson('{"summary":null}').parties, []);
  assert.throws(() => parseCardJson('I cannot help with that.'), /no JSON/);
  assert.throws(() => parseCardJson('{"summary": "cut off'), /incomplete/);
  const prompt = cardPrompt({ title: 'CA', text: 'x'.repeat(20_000), outline: [{ depth: 1, entry: '1. Definitions' }], documentTypes: [{ id: 'type-1', name: 'Concession Agreement' }] });
  assert.ok(prompt.includes('type-1: Concession Agreement'));
  assert.ok(prompt.includes('1. Definitions'));
  assert.ok(prompt.length < 13_000, 'only the opening of the document is sent');
});

test('reader entry point: text, Markdown, CSV and Word; unsupported types are a plain permanent error', async () => {
  const txt = await extractForIndex(new TextEncoder().encode('﻿1. Parties\n\nThe Agency.\n\n2. Term\n\nTen years.'), 'notes.txt');
  assert.equal(txt.blocks[0].text, '1. Parties');
  const md = await extractForIndex(new TextEncoder().encode('# Memo\n\nIntro.\n\n## Risks\n\nThe cap is low.'), 'memo.md');
  const { chunks } = chunkDocument(md.blocks);
  assert.equal(chunks[chunks.length - 1].headingPath, 'Memo › Risks');
  const csv = await extractForIndex(new TextEncoder().encode('Name,Amount\nRent,100\n'), 'roll.csv');
  assert.equal(csv.blocks.length, 2);
  const docx = await extractForIndex(agreementDocx(), 'file.docx');
  assert.equal(docx.extractor, 'ooxml');
  assert.equal(docx.hasTrackedChanges, true);
  await assert.rejects(extractForIndex(new Uint8Array([1]), 'photo.jpg'), (err) => err instanceof PermanentError && /cannot be read for search/.test(err.message));
  await assert.rejects(extractForIndex(new Uint8Array(0), 'empty.txt'), /empty/);
});

test('failure sentences: permanent reasons pass through, others say it will be retried', () => {
  assert.equal(plainError(new PermanentError('The PDF is password-protected.')), 'The PDF is password-protected.');
  assert.match(plainError(new Error('socket hang up')), /tried again automatically/);
  assert.match(plainError(Object.assign(new Error('x'), { missingTool: 'tesseract' })), /missing a tool/);
});
