import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { bestPassages, TOOL_TURN_PASSAGES, alignCommentExpectations } from '../libraryTools.js';
import { inspectDocx, applyDocxOps } from '../docxAgent.js';

// ---------------------------------------------------------------- bestPassages

test('a turn with tools is handed the three best passages overall, from any library', () => {
  const sources = [
    { id: 'm1', scope: 'matter', similarity: 0.52 },
    { id: 'm2', scope: 'matter', similarity: 0.40 },
    { id: 'p1', scope: 'precedent', similarity: 0.61 },
    { id: 'p2', scope: 'precedent', similarity: 0.38 },
    { id: 's1', scope: 'statute', similarity: 0.55 },
    { id: 's2', scope: 'statute', similarity: 0.36 },
  ];
  assert.equal(TOOL_TURN_PASSAGES, 3);
  assert.deepEqual(bestPassages(sources).map((s) => s.id), ['p1', 's1', 'm1']);
});

test('fewer passages than the limit are all kept; ties keep their order; no score sorts last', () => {
  assert.deepEqual(bestPassages([{ id: 'a', similarity: 0.4 }]).map((s) => s.id), ['a']);
  assert.deepEqual(bestPassages([]), []);
  assert.deepEqual(bestPassages(undefined), []);
  const tied = [{ id: 'x', similarity: 0.5 }, { id: 'none' }, { id: 'y', similarity: 0.5 }, { id: 'z', similarity: 0.45 }];
  assert.deepEqual(bestPassages(tied).map((s) => s.id), ['x', 'y', 'z']);
  assert.deepEqual(bestPassages(tied, 2).map((s) => s.id), ['x', 'y']);
});

// ------------------------------------------------------ alignCommentExpectations

const byRef = new Map([
  [12, { exactText: 'The Concession Period shall be twenty (20) years.' }],
  [13, { exactText: 'The Authority shall grant the Site.' }],
]);

test('a comment quoting the new wording of a paragraph the same reply rewrites is checked against the old wording', () => {
  const ops = [
    { op: 'replace', p: 12, expected: 'The Concession Period shall be twenty (20) years.', text: 'The Concession Period shall be thirty (30) years.' },
    { op: 'comment', p: 12, expected: 'The Concession Period shall be  thirty (30) years. ', text: 'The Firm notes the period follows the term sheet.' },
  ];
  const out = alignCommentExpectations(ops, byRef);
  assert.equal(out[1].expected, 'The Concession Period shall be twenty (20) years.');
  assert.equal(out[1].text, ops[1].text);
  // The input is left as it was.
  assert.equal(ops[1].expected, 'The Concession Period shall be  thirty (30) years. ');
  assert.equal(out[0], ops[0]);
});

test('a comment quoting the old wording, or on another paragraph, is left alone', () => {
  const ops = [
    { op: 'replace', p: 12, expected: 'The Concession Period shall be twenty (20) years.', text: 'The Concession Period shall be thirty (30) years.' },
    { op: 'comment', p: 12, expected: 'The Concession Period shall be twenty (20) years.', text: 'Old wording quoted.' },
    { op: 'comment', p: 13, expected: 'The Concession Period shall be thirty (30) years.', text: 'Wrong paragraph.' },
  ];
  const out = alignCommentExpectations(ops, byRef);
  assert.equal(out[1], ops[1]);
  assert.equal(out[2], ops[2]);
});

test('nothing is loosened when the replace itself would be refused, or when the comment matches neither wording', () => {
  const staleReplace = [
    { op: 'replace', p: 12, expected: 'Some other text.', text: 'The Concession Period shall be thirty (30) years.' },
    { op: 'comment', p: 12, expected: 'The Concession Period shall be thirty (30) years.', text: 'x' },
  ];
  assert.equal(alignCommentExpectations(staleReplace, byRef)[1].expected, 'The Concession Period shall be thirty (30) years.');
  const unrelated = [
    { op: 'replace', p: 12, expected: 'The Concession Period shall be twenty (20) years.', text: 'The Concession Period shall be thirty (30) years.' },
    { op: 'comment', p: 12, expected: 'Something the paragraph never said.', text: 'x' },
  ];
  assert.equal(alignCommentExpectations(unrelated, byRef)[1].expected, 'Something the paragraph never said.');
  assert.equal(alignCommentExpectations(null, byRef), null);
});

// The same reply, through the Word engine: before, the comment was skipped
// with "Expected paragraph text does not match the source".
test('in the Word file, a rewrite and a comment quoting its new wording both land', async () => {
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const bytes = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    'word/document.xml': strToU8(`<w:document ${ns}><w:body><w:p><w:r><w:t>The term is twenty years.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`),
  });
  const view = inspectDocx(bytes);
  const [p] = [...view.byRef].find(([, r]) => r.exactText === 'The term is twenty years.');
  const ops = [
    { op: 'replace', p, expected: 'The term is twenty years.', text: 'The term is thirty years.' },
    { op: 'comment', p, expected: 'The term is thirty years.', text: 'The Firm notes the term follows the term sheet.' },
  ];
  const before = await applyDocxOps(bytes, ops, view.byRef);
  assert.equal(before.results.find((r) => r.kind === 'comment').status, 'skipped');
  const after = await applyDocxOps(bytes, alignCommentExpectations(ops, view.byRef), view.byRef);
  assert.deepEqual(after.results.map((r) => r.status), ['applied', 'applied']);
  const files = unzipSync(after.bytes);
  assert.match(strFromU8(files['word/document.xml']), /commentReference/);
  assert.match(strFromU8(files['word/comments.xml']), /term follows the term sheet/);
});
