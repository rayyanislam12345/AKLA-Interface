import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { inspectDocx, applyDocxOps, acceptAllChanges, acceptChangesBy, applyReviewSuggestions } from '../docxAgent.js';
import { inspectPackage } from '../docxChecks.js';
import {
  applyDecisions, findRevisions, reconcile, editRecords, reviewRecords, codeFor,
  stateOf, cardFor, cardsFor, countsFor, withDocumentLock, PLACEMENT_TEXT,
} from '../changes.js';
import { chooseWorkingDocument } from '../chatState.js';

const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
const PART = 'word/document.xml';
const docXml = (bytes, part = PART) => strFromU8(unzipSync(bytes)[part]);
const docFrom = (body) => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
  [PART]: strToU8(`<w:document ${ns}><w:body>${body}<w:sectPr/></w:body></w:document>`),
});
const COUNSEL = '<w:ins w:id="1" w:author="Counsel" w:date="2026-09-01T00:00:00Z"><w:r><w:t>redline</w:t></w:r></w:ins>';
const paragraphs = (xml) => (xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p\/>/g) ?? []);
const idsIn = (xml) => [...xml.matchAll(/<w:(?:ins|del)\s[^>]*?\bw:id="(\d+)"/g)].map((m) => Number(m[1]));

// ¶A plain, ¶B with Counsel's insertion, ¶C with a footnote mark in its
// middle run, and one table cell with one paragraph.
const FIXTURE_BODY =
  `<w:p w14:paraId="0A"><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>Party Alpha pays 10.</w:t></w:r></w:p>`
  + `<w:p><w:r><w:t xml:space="preserve">Existing </w:t></w:r>${COUNSEL}<w:r><w:t xml:space="preserve"> stays.</w:t></w:r></w:p>`
  + `<w:p><w:r><w:t xml:space="preserve">Pay within </w:t></w:r><w:r><w:t>thirty</w:t><w:footnoteReference w:id="2"/></w:r><w:r><w:t xml:space="preserve"> days.</w:t></w:r></w:p>`
  + `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell text.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;

// The fixture with four AKLA AI changes written in: a replace on ¶A, a
// replace on ¶C that strikes the footnote run whole, a delete of the cell
// paragraph and a paragraph added after ¶A. Returns the file and one
// decision item per change.
async function fixture() {
  const bytes = docFrom(FIXTURE_BODY);
  const view = inspectDocx(bytes);
  const at = (text) => [...view.byRef].find(([, r]) => r.exactText === text)[0];
  const ops = [
    { op: 'replace', p: at('Party Alpha pays 10.'), expected: 'Party Alpha pays 10.', text: 'Party Beta pays 20.', why: 'Beta is the payer.' },
    { op: 'replace', p: at('Pay within thirty days.'), expected: 'Pay within thirty days.', text: 'Pay within forty days.' },
    { op: 'delete', p: at('Cell text.'), expected: 'Cell text.' },
    { op: 'insert_after', p: at('Party Alpha pays 10.'), expected: 'Party Alpha pays 10.', text: 'Added clause.' },
  ];
  const out = await applyDocxOps(bytes, ops, view.byRef);
  assert.equal(out.applied, 4);
  for (const r of out.results) assert.equal(r.via, 'inline');
  const item = (n, id, decision) => ({ id, part: PART, revisionIds: out.results[n].revisionIds, decision });
  return {
    input: bytes, bytes: out.bytes, results: out.results,
    replaceA: (d) => item(0, 'a', d), replaceC: (d) => item(1, 'c', d), deleteCell: (d) => item(2, 'd', d), addAfterA: (d) => item(3, 'i', d),
  };
}

test('accept of a replace writes the new words in and touches nothing else', async () => {
  const f = await fixture();
  const { bytes, results } = applyDecisions(f.bytes, [f.replaceA('accepted')]);
  const xml = docXml(bytes);
  assert.deepEqual(results, [{ id: 'a', status: 'applied' }]);
  for (const id of f.results[0].revisionIds) assert.ok(!xml.includes(`w:id="${id}"`), `id ${id} is gone`);
  assert.ok(xml.includes('<w:r><w:t xml:space="preserve">Beta pays 20.</w:t></w:r>'));
  assert.ok(!paragraphs(xml).find((p) => p.includes('Beta pays 20.')).includes('<w:ins'));
  assert.equal(/<w:ins w:id="1"[\s\S]*?<\/w:ins>/.exec(xml)[0], COUNSEL, 'the Counsel insertion is byte-identical');
  assert.ok(xml.includes('<w:footnoteReference w:id="2"/>'));
  // The other three changes are still there to decide.
  for (const r of f.results.slice(1)) for (const id of r.revisionIds) assert.ok(xml.includes(`w:id="${id}"`));
});

test('reject of a replace restores the original text, footnote mark included', async () => {
  const f = await fixture();
  const { bytes, results } = applyDecisions(f.bytes, [f.replaceA('rejected'), f.replaceC('rejected')]);
  const xml = docXml(bytes);
  assert.deepEqual(results.map((r) => r.status), ['applied', 'applied']);
  const [A, , C] = paragraphs(xml);
  assert.ok(!A.includes('<w:delText') && !C.includes('<w:delText') && !A.includes('w:id=') && !C.includes('w:id="9'));
  assert.ok(xml.includes('<w:t xml:space="preserve">Alpha pays 10.</w:t>'));
  assert.ok(xml.includes('<w:r><w:t>thirty</w:t><w:footnoteReference w:id="2"/></w:r>'), 'the struck run is live again, its footnote mark inside it');
  assert.ok(!xml.includes('forty') && !xml.includes('Beta'));
  assert.ok([...inspectDocx(bytes).byRef.values()].some((r) => r.exactText === 'Pay within thirty days.'));
});

test('reject of an added paragraph removes it; accept keeps it plain', async () => {
  const f = await fixture();
  const rejected = docXml(applyDecisions(f.bytes, [f.addAfterA('rejected')]).bytes);
  assert.ok(!rejected.includes('Added clause.'));
  assert.equal(paragraphs(rejected).length, paragraphs(docXml(f.input)).length, 'no empty paragraph is left behind');
  const accepted = docXml(applyDecisions(f.bytes, [f.addAfterA('accepted')]).bytes);
  const added = paragraphs(accepted).find((p) => p.includes('Added clause.'));
  assert.ok(added && !added.includes('<w:ins'));
  for (const id of f.results[3].revisionIds) assert.ok(!accepted.includes(`w:id="${id}"`));
});

test('accept of a deleted paragraph removes it; a cell is never left empty', async () => {
  const f = await fixture();
  const accepted = docXml(applyDecisions(f.bytes, [f.deleteCell('accepted')]).bytes);
  assert.ok(/<w:tc><w:p\/><\/w:tc>/.test(accepted));
  assert.ok(!accepted.includes('Cell text.'));
  const rejected = docXml(applyDecisions(f.bytes, [f.deleteCell('rejected')]).bytes);
  assert.ok(/<w:tc><w:p><w:r><w:t>Cell text.<\/w:t><\/w:r><\/w:p><\/w:tc>/.test(rejected));
});

test('a change with any id missing is not touched', async () => {
  const f = await fixture();
  const item = f.replaceA('accepted');
  item.revisionIds = [...item.revisionIds, 123456];
  const { bytes, results } = applyDecisions(f.bytes, [item]);
  assert.deepEqual(results, [{ id: 'a', status: 'missing', reason: 'changed_since' }]);
  assert.deepEqual(unzipSync(bytes)[PART], unzipSync(f.bytes)[PART]);
  // A part the file does not have is missing too.
  assert.equal(applyDecisions(f.bytes, [{ ...f.replaceA('accepted'), part: 'word/header1.xml' }]).results[0].status, 'missing');
});

test('a paragraph merge needs Word', () => {
  const bytes = docFrom('<w:p><w:pPr><w:rPr><w:del w:id="50" w:author="AKLA AI" w:date="2026-10-14T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t>Live text</w:t></w:r></w:p><w:p><w:r><w:t>Next.</w:t></w:r></w:p>');
  const accept = applyDecisions(bytes, [{ id: 'm', part: PART, revisionIds: [50], decision: 'accepted' }]);
  assert.deepEqual(accept.results, [{ id: 'm', status: 'blocked', reason: 'paragraph_merge' }]);
  assert.deepEqual(accept.bytes, bytes);
  const reject = applyDecisions(bytes, [{ id: 'm', part: PART, revisionIds: [50], decision: 'rejected' }]);
  assert.equal(reject.results[0].status, 'applied');
  const xml = docXml(reject.bytes);
  assert.ok(!xml.includes('w:id="50"') && xml.includes('<w:r><w:t>Live text</w:t></w:r>'));
  // The reverse: an added paragraph someone typed into cannot be rejected here.
  const typed = docFrom('<w:p><w:pPr><w:rPr><w:ins w:id="60" w:author="AKLA AI" w:date="D"/></w:rPr></w:pPr><w:ins w:id="61" w:author="AKLA AI" w:date="D"><w:r><w:t>Ours</w:t></w:r></w:ins><w:r><w:t>theirs</w:t></w:r></w:p>');
  const r = applyDecisions(typed, [{ id: 't', part: PART, revisionIds: [60, 61], decision: 'rejected' }]);
  assert.deepEqual(r.results, [{ id: 't', status: 'blocked', reason: 'typed_into' }]);
  assert.deepEqual(r.bytes, typed);
});

test('deciding is deterministic and composes', async () => {
  const f = await fixture();
  const items = [f.replaceA('accepted'), f.replaceC('rejected')];
  const once = applyDecisions(f.bytes, items);
  const twice = applyDecisions(f.bytes, items);
  assert.deepEqual(once.results.map((r) => r.status), ['applied', 'applied']);
  const entries = (b) => Object.fromEntries(Object.entries(unzipSync(b)).map(([k, v]) => [k, strFromU8(v)]));
  assert.deepEqual(entries(once.bytes), entries(twice.bytes), 'every part is byte-identical between runs');
  // What is left (the deleted cell paragraph and the added paragraph) still accepts cleanly.
  const clean = docXml(acceptAllChanges(once.bytes));
  assert.ok(clean.includes('Beta pays 20.') && clean.includes('thirty') && clean.includes('Added clause.') && !clean.includes('Cell text.'));
  assert.deepEqual(inspectPackage({ [PART]: docXml(once.bytes) }).errors, []);
  // Deciding the rest in a second call leaves no AKLA AI revision at all.
  const rest = applyDecisions(once.bytes, [f.deleteCell('accepted'), f.addAfterA('accepted')]);
  assert.equal(findRevisions(rest.bytes).ours.size, 0);
  assert.equal(findRevisions(rest.bytes).others, 1);
});

test('reconcile explains every vanished id', async () => {
  const f = await fixture();
  const row = (id, result, extra = {}) => ({ id, status: 'pending', placement: 'placed', part: PART, revision_ids: result.revisionIds, ...extra });
  const A = row('A', f.results[3]);
  const B = row('B', f.results[0]);
  // A later turn rewrites the paragraph A added: it takes A's ids over.
  const view = inspectDocx(f.bytes);
  const [p] = [...view.byRef].find(([, r]) => r.exactText === 'Added clause.');
  const second = await applyDocxOps(f.bytes, [{ op: 'replace', p, expected: 'Added clause.', text: 'Rewritten clause.' }], view.byRef);
  assert.deepEqual(second.results[0].takesOver, A.revision_ids);
  const rows = [
    A, B,
    row('W', { revisionIds: [777] }),
    row('X', { revisionIds: [888] }),
    row('D', { revisionIds: [999] }, { status: 'accepted' }),
    row('P', { revisionIds: [f.results[0].revisionIds[0], 555] }, { status: 'pending', placement: 'unplaced' }),
  ];
  const results = [
    { ...second.results[0], rowId: 'new-1' },
    { kind: 'delete', status: 'applied', part: PART, revisionIds: [], removedIds: [777] },
    { kind: 'replace', status: 'applied', part: PART, revisionIds: [9050], splits: [{ fromId: B.revision_ids[0], toId: 9051, author: 'AKLA AI' }] },
  ];
  const patches = Object.fromEntries(reconcile(second.bytes, rows, results).map((p) => [p.id, p.patch]));
  assert.deepEqual(patches.A, { placement: 'superseded', placement_reason: 'replaced', superseded_by: 'new-1' });
  assert.deepEqual(patches.W, { placement: 'superseded', placement_reason: 'withdrawn' });
  assert.deepEqual(patches.X, { placement: 'unplaced', placement_reason: 'changed_since' });
  assert.deepEqual(patches.B, { revision_ids: [...B.revision_ids, 9051] });
  assert.ok(!('D' in patches), 'a decided row is never patched');
  assert.ok(!('P' in patches), 'a row that was never placed is left alone');
  // With nothing to explain them, ids all present means no patch at all.
  assert.deepEqual(reconcile(f.bytes, [A, B], []), []);
  assert.deepEqual(reconcile(second.bytes, [A], []), [{ id: 'A', patch: { placement: 'unplaced', placement_reason: 'changed_since' } }]);
});

test('records carry the plain reasons and the right source', async () => {
  const f = await fixture();
  const ctx = { threadId: 'thread', rootId: 'root', userId: 'user' };
  const bytes = docFrom(FIXTURE_BODY);
  const refused = await applyDocxOps(bytes, [
    { op: 'replace', p: 1, expected: 'Wrong', text: 'x' },
    { op: 'comment', p: 1, expected: 'Party Alpha pays 10.', text: 'Note' },
  ], inspectDocx(bytes).byRef);
  const hidden = await applyDocxOps(bytes, [{ op: 'delete', p: 1, expected: 'Party Alpha pays 10.' }], inspectDocx(bytes, { budget: 0 }).byRef);
  const header = { kind: 'comment', status: 'skipped', reason: 'Word does not allow comments in headers, footers or notes.', p: 9 };
  const { rows, withdrawals } = editRecords([...refused.results, ...hidden.results, header], ctx);
  assert.equal(rows.length, 2, 'comments never make a row');
  assert.deepEqual(rows.map((r) => [r.placement, r.placement_reason]), [['unplaced', 'stale'], ['unplaced', 'hidden']]);
  assert.equal(codeFor('Word does not allow comments in headers, footers or notes.'), 'comment_location');
  assert.equal(codeFor('ambiguous'), 'ambiguous');
  assert.equal(codeFor('Something the engine said'), 'Something the engine said');
  assert.deepEqual(withdrawals, []);
  assert.deepEqual(rows[0], {
    thread_id: 'thread', artifact_id: 'root', message_id: null, document_version_id: null, review_run_id: null,
    review_type: 'edit', op: 'replace', part: PART, paragraph_index: 1, clause_reference: null,
    original_text: 'Party Alpha pays 10.', suggested_text: 'x', rationale: null, status: 'pending',
    decided_by: null, decided_at: null, revision_ids: [], placement: 'unplaced', placement_reason: 'stale', created_by: 'user',
  });

  // The fixture's four applied ops: one placed row each, the writer's words and reason.
  const placed = editRecords(f.results, ctx).rows;
  assert.equal(placed.length, 4);
  assert.deepEqual(placed.map((r) => r.op), ['replace', 'replace', 'delete', 'insert_after']);
  assert.deepEqual([placed[0].original_text, placed[0].suggested_text, placed[0].rationale], ['Party Alpha pays 10.', 'Party Beta pays 20.', 'Beta is the payer.']);
  assert.deepEqual([placed[2].original_text, placed[2].suggested_text], ['Cell text.', '']);
  assert.deepEqual([placed[3].original_text, placed[3].suggested_text], ['', 'Added clause.']);
  for (const r of placed) assert.ok(r.placement === 'placed' && r.placement_reason === null && r.revision_ids.length > 0);

  // Deleting a paragraph the AI added is a withdrawal, not a row.
  const view = inspectDocx(f.bytes);
  const [p] = [...view.byRef].find(([, r]) => r.exactText === 'Added clause.');
  const removed = await applyDocxOps(f.bytes, [{ op: 'delete', p, expected: 'Added clause.' }], view.byRef);
  const w = editRecords(removed.results, ctx);
  assert.equal(w.rows.length, 0);
  assert.deepEqual(w.withdrawals[0].removedIds, f.results[3].revisionIds);

  // A fill-in from the standard is born accepted, with no ids to decide.
  const fill = editRecords(f.results, { ...ctx, fillIn: true }).rows[0];
  assert.equal(fill.review_type, 'standard_fill');
  assert.equal(fill.status, 'accepted');
  assert.deepEqual(fill.revision_ids, []);
  assert.ok(typeof fill.decided_at === 'string' && !Number.isNaN(Date.parse(fill.decided_at)));

  // Review rows: the file's wording when placed, the stripped quote when not.
  const tagged = [
    { clause_reference: '4.2', original_text: '<p>Party Alpha pays 10.</p>', suggested_text: '<p>Party Beta pays 20.</p>', rationale: 'r1', review_type: 'legal_clauses' },
    { clause_reference: '7', original_text: 'Not <b>here</b><sup>[1]</sup> at all', suggested_text: 'Anything <i>else</i>', rationale: 'r2', review_type: 'formatting' },
  ];
  const results = [
    { id: 0, status: 'applied', part: PART, paragraphIndex: 1, clause: '4.2', original: 'Party Alpha pays 10.', suggested: 'Party Beta pays 20.', revisionIds: [9001, 9002] },
    { id: 1, status: 'skipped', reason: 'not_found', part: null, paragraphIndex: null, clause: '7', original: 'Not here at all', suggested: 'Anything else', revisionIds: [] },
  ];
  const review = reviewRecords(tagged, results, { ...ctx, reviewRunId: 'run' });
  assert.deepEqual(review[0], {
    thread_id: 'thread', artifact_id: 'root', message_id: null, document_version_id: null, review_run_id: 'run',
    review_type: 'legal_clauses', op: 'replace', part: PART, paragraph_index: 1, clause_reference: '4.2',
    original_text: 'Party Alpha pays 10.', suggested_text: 'Party Beta pays 20.', rationale: 'r1', status: 'pending',
    revision_ids: [9001, 9002], placement: 'placed', placement_reason: null, created_by: 'user',
  });
  assert.deepEqual([review[1].original_text, review[1].suggested_text, review[1].placement, review[1].placement_reason, review[1].revision_ids], ['Not here at all', 'Anything else', 'unplaced', 'not_found', []]);
  assert.equal(reviewRecords([{ ...tagged[1], review_type: undefined }], [], ctx)[0].review_type, 'chat');

  // Every code a record can carry has its sentence.
  const codes = ['hidden', 'stale', 'comment_location', 'no_change', 'not_found', 'ambiguous', 'overlaps_another_suggestion', 'formatting', 'formatting_only', 'paragraph_structure', 'missing_text', 'changed_since', 'paragraph_merge', 'typed_into', 'withdrawn'];
  for (const code of codes) assert.equal(typeof PLACEMENT_TEXT[code], 'string', `${code} has a sentence`);
  assert.equal(codeFor('no change'), 'no_change');
});

test('cards and counts say what the lawyer sees', async () => {
  const f = await fixture();
  const base = (id, extra) => ({ id, review_type: 'edit', op: 'replace', part: PART, paragraph_index: 1, clause_reference: '1', original_text: 'a', suggested_text: 'b', rationale: 'why', status: 'pending', placement: 'placed', placement_reason: null, superseded_by: null, decided_by: null, decided_at: null, message_id: 'm', created_at: `2026-10-14T10:00:0${id}Z`, revision_ids: [9001], ...extra });
  const rows = [
    base(1, { placement: 'superseded', placement_reason: 'replaced', superseded_by: 2 }),
    base(2, { op: 'insert_after' }),
    base(3, { placement: 'unplaced', placement_reason: 'not_found', revision_ids: [] }),
    base(4, { placement: 'blocked', placement_reason: 'paragraph_merge', op: 'delete' }),
    base(5, { status: 'accepted', decided_by: 'u1', decided_at: '2026-10-14T11:00:00Z', review_type: 'legal_clauses', part: 'word/header1.xml' }),
    base(6, { status: 'rejected', decided_by: 'u2', decided_at: '2026-10-14T11:00:00Z', review_type: 'chat' }),
    base(7, { placement: 'superseded', placement_reason: 'withdrawn' }),
    base(8, { placement: 'unplaced', placement_reason: 'The engine said this.' }),
  ];
  const names = new Map([['u1', 'Ambreen Khan']]);
  const cards = cardsFor(rows, names);
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.deepEqual(cards.map((c) => c.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([by[2].state, by[2].stateLabel, by[2].stateNote, by[2].canAccept, by[2].canReject, by[2].kind], ['waiting', 'Waiting for you', null, true, true, 'addition']);
  assert.deepEqual([by[3].state, by[3].stateNote], ['could_not_place', PLACEMENT_TEXT.not_found]);
  assert.deepEqual([by[4].state, by[4].stateLabel, by[4].stateNote, by[4].kind, by[4].canAccept], ['needs_word', 'Needs Word', PLACEMENT_TEXT.paragraph_merge, 'deletion', false]);
  assert.deepEqual([by[1].state, by[1].stateNote, by[1].replacedBy], ['replaced', 'Replaced by change 2.', 2]);
  assert.deepEqual([by[7].state, by[7].stateNote], ['replaced', 'Withdrawn by a later AI change.']);
  assert.deepEqual([by[5].state, by[5].decided, by[5].sourceLabel, by[5].where], ['accepted', { by: { id: 'u1', name: 'Ambreen Khan' }, at: '2026-10-14T11:00:00Z' }, 'Review: legal clauses', { part: 'header', paragraph: 1, clause: '1' }]);
  assert.deepEqual([by[6].state, by[6].decided.by, by[6].sourceLabel, by[6].canAccept], ['rejected', { id: 'u2', name: null }, 'Review follow-up', false]);
  assert.equal(by[8].stateNote, 'The engine said this.');
  assert.deepEqual([by[2].before, by[2].after, by[2].why, by[2].turn, by[2].source], ['a', 'b', 'why', { messageId: 'm', at: '2026-10-14T10:00:02Z' }, 'edit']);
  assert.equal(cardFor(rows[0], { number: 1 }).stateNote, 'Replaced by a later AI change.');
  assert.equal(stateOf(base(9, { status: 'accepted', placement: 'unplaced', placement_reason: 'stale' })), 'could_not_place');
  assert.deepEqual(countsFor(rows, findRevisions(f.bytes).others), { waiting: 1, accepted: 1, rejected: 1, couldNotPlace: 2, needsWord: 1, replaced: 2, total: 8, othersRevisions: 1 });
  assert.equal(findRevisions(f.bytes).ours.size, f.results.reduce((n, r) => n + r.revisionIds.length, 0));
  assert.ok(findRevisions(f.bytes).ours.has(`${PART}#${f.results[0].revisionIds[0]}`));
});

test('the working document is known by its id before its chain', () => {
  const doc = (id, data, title = 'Agreement') => ({ id, kind: 'docx', title, data });
  // Two copies naming the same document, with no chain between them.
  const root = doc('r', { storagePath: 'x/r.docx', workingDocumentId: 'r' });
  const turn = doc('t', { storagePath: 'x/t.docx', workingDocumentId: 'r' });
  const one = chooseWorkingDocument([root, turn], {});
  assert.equal(one.chosen.id, 't');
  assert.equal(one.root.id, 'r');
  assert.deepEqual(one.others, []);
  // An old chain without the id still resolves.
  const old = doc('o', { storagePath: 'y/o.docx' }, 'Old note');
  const oldCopy = doc('o2', { storagePath: 'y/o2.docx', sourceStoragePath: 'y/o.docx' }, 'Old note');
  const chain = chooseWorkingDocument([old, oldCopy], {});
  assert.equal(chain.chosen.id, 'o2');
  assert.equal(chain.root.id, 'o');
  // A decision copy beside the turn copy is the head, by id and by chain alike.
  const decision = doc('d', { storagePath: 'x/d.docx', sourceStoragePath: 'x/t.docx', workingDocumentId: 'r', producedBy: 'decision' });
  const all = [root, old, turn, oldCopy, decision];
  assert.equal(chooseWorkingDocument(all, { workingArtifactId: 't' }).chosen.id, 'd');
  assert.equal(chooseWorkingDocument(all, { workingArtifactId: 'r' }).chosen.id, 'd');
  assert.equal(chooseWorkingDocument(all, { workingArtifactId: 'd' }).root.id, 'r');
  assert.equal(chooseWorkingDocument(all, { workingArtifactId: 'o2' }).chosen.id, 'o2');
  assert.deepEqual(chooseWorkingDocument(all, { workingArtifactId: 'd' }).others.map((a) => a.id), ['o']);
  // The first turn on an old thread names the chain's root: both ways of knowing agree.
  const named = doc('n', { storagePath: 'y/n.docx', sourceStoragePath: 'y/o2.docx', workingDocumentId: 'o' }, 'Old note');
  assert.equal(chooseWorkingDocument([old, oldCopy, named], { workingArtifactId: 'o' }).chosen.id, 'n');
  // A copy naming a root that is not in the thread still groups with its siblings.
  const orphan1 = doc('p1', { storagePath: 'z/1.docx', workingDocumentId: 'gone' });
  const orphan2 = doc('p2', { storagePath: 'z/2.docx', workingDocumentId: 'gone' });
  const orphans = chooseWorkingDocument([orphan1, orphan2], {});
  assert.equal(orphans.chosen.id, 'p2');
  assert.equal(orphans.root.id, 'p1');
});

test('withDocumentLock serialises work on one document', async () => {
  const order = [];
  const step = (name, ms) => () => new Promise((resolve) => setTimeout(() => { order.push(name); resolve(name); }, ms));
  const results = await Promise.all([
    withDocumentLock('doc-1', step('a1', 30)),
    withDocumentLock('doc-1', step('a2', 1)),
    withDocumentLock('doc-2', step('b1', 5)),
  ]);
  assert.deepEqual(results, ['a1', 'a2', 'b1']);
  assert.deepEqual(order, ['b1', 'a1', 'a2'], 'a2 waits for a1; b1 does not');
  // A failure releases the lock for the next caller.
  await assert.rejects(withDocumentLock('doc-1', () => Promise.reject(new Error('no'))), /no/);
  assert.equal(await withDocumentLock('doc-1', async () => 'after'), 'after');
});

// ---- Reviewer findings: self-closing paragraphs, nested changes, splits in
// one call, cells ending in a table, byte-identical output, card order.

const AI_ADDED = '<w:p><w:pPr><w:rPr><w:ins w:id="60" w:author="AKLA AI" w:date="D"/></w:rPr></w:pPr><w:ins w:id="61" w:author="AKLA AI" w:date="D"><w:r><w:t>Ours</w:t></w:r></w:ins></w:p>';
const AI_DELETED = '<w:p><w:pPr><w:rPr><w:del w:id="70" w:author="AKLA AI" w:date="D"/></w:rPr></w:pPr><w:del w:id="71" w:author="AKLA AI" w:date="D"><w:r><w:delText>Gone</w:delText></w:r></w:del></w:p>';
const AFTER = '<w:p><w:r><w:t>After.</w:t></w:r></w:p>';

test('an empty self-closing paragraph before a decided one is left where it is', () => {
  const empty = '<w:p w:rsidR="00AB"/>';
  // Rejecting an added paragraph after an empty one drops only the added one.
  const added = docFrom(`<w:p><w:r><w:t>Before.</w:t></w:r></w:p>${empty}${AI_ADDED}${AFTER}`);
  const rej = applyDecisions(added, [{ id: 't', part: PART, revisionIds: [60, 61], decision: 'rejected' }]);
  assert.deepEqual(rej.results, [{ id: 't', status: 'applied' }]);
  assert.equal(docXml(rej.bytes), docXml(docFrom(`<w:p><w:r><w:t>Before.</w:t></w:r></w:p>${empty}${AFTER}`)));
  // Accepting a deleted paragraph after an empty one: the same, every way a file is accepted.
  const deleted = docFrom(`${empty}${AI_DELETED}${AFTER}`);
  const want = docXml(docFrom(`${empty}${AFTER}`));
  const acc = applyDecisions(deleted, [{ id: 't', part: PART, revisionIds: [70, 71], decision: 'accepted' }]);
  assert.deepEqual(acc.results, [{ id: 't', status: 'applied' }]);
  assert.equal(docXml(acc.bytes), want);
  assert.equal(docXml(acceptAllChanges(deleted)), want);
  assert.equal(docXml(acceptChangesBy(deleted)), want);
  // An empty paragraph closing a table cell, then an added paragraph: the table survives intact.
  const table = docFrom(`<w:tbl><w:tr><w:tc>${empty}</w:tc></w:tr></w:tbl>${AI_ADDED}${AFTER}`);
  const t = applyDecisions(table, [{ id: 't', part: PART, revisionIds: [60, 61], decision: 'rejected' }]);
  assert.deepEqual(t.results, [{ id: 't', status: 'applied' }]);
  assert.equal(docXml(t.bytes), docXml(docFrom(`<w:tbl><w:tr><w:tc>${empty}</w:tc></w:tr></w:tbl>${AFTER}`)));
  assert.ok(docXml(acceptAllChanges(table)).includes(`<w:tbl><w:tr><w:tc>${empty}</w:tc></w:tr></w:tbl>`));
  // The checks that read the paragraph before a mark are not misled either.
  const live = docFrom(`<w:p><w:r><w:t>Live before.</w:t></w:r></w:p>${empty}${AI_DELETED}`);
  assert.equal(applyDecisions(live, [{ id: 't', part: PART, revisionIds: [70, 71], decision: 'accepted' }]).results[0].status, 'applied');
});

test('rejecting an insertion with a later change inside it needs that change decided first', async () => {
  // Turn one changes "Alpha pays 10." to "Beta pays twenty."; turn two changes "twenty." inside that insertion.
  const bytes = docFrom('<w:p><w:r><w:t xml:space="preserve">Party Alpha pays 10.</w:t></w:r></w:p>');
  const first = await applyDocxOps(bytes, [{ op: 'replace', p: 1, expected: 'Party Alpha pays 10.', text: 'Party Beta pays twenty.' }], inspectDocx(bytes).byRef);
  const r1 = first.results[0];
  const second = await applyDocxOps(first.bytes, [{ op: 'replace', p: 1, expected: 'Party Beta pays twenty.', text: 'Party Beta pays 20.' }], inspectDocx(first.bytes).byRef, { idFloor: first.maxId });
  const r2 = second.results[0];
  const item = (id, r, decision) => ({ id, part: PART, revisionIds: r.revisionIds, decision });
  // Alone, the earlier change cannot be rejected: the later one would go with it, undecided.
  const alone = applyDecisions(second.bytes, [item('R1', r1, 'rejected')]);
  assert.deepEqual(alone.results, [{ id: 'R1', status: 'blocked', reason: 'nested_change' }]);
  assert.deepEqual(alone.bytes, second.bytes);
  // Accepting it is fine, and so is rejecting it once the later change is decided — or alongside it.
  assert.equal(applyDecisions(second.bytes, [item('R1', r1, 'accepted')]).results[0].status, 'applied');
  const laterFirst = applyDecisions(second.bytes, [item('R2', r2, 'rejected')]);
  assert.equal(laterFirst.results[0].status, 'applied');
  const then = applyDecisions(laterFirst.bytes, [item('R1', r1, 'rejected')]);
  assert.equal(then.results[0].status, 'applied');
  assert.equal([...inspectDocx(then.bytes).byRef.values()][0].exactText, 'Party Alpha pays 10.');
  const both = applyDecisions(second.bytes, [item('R1', r1, 'rejected'), item('R2', r2, 'rejected')]);
  assert.deepEqual(both.results.map((r) => r.status), ['applied', 'applied']);
  assert.equal([...inspectDocx(both.bytes).byRef.values()][0].exactText, 'Party Alpha pays 10.');
  assert.equal(findRevisions(both.bytes).ours.size, 0);
  // Someone else's deletion inside the AI's added paragraph counts too.
  const struck = docFrom('<w:p><w:pPr><w:rPr><w:ins w:id="60" w:author="AKLA AI" w:date="D"/></w:rPr></w:pPr><w:ins w:id="61" w:author="AKLA AI" w:date="D"><w:r><w:t xml:space="preserve">Added </w:t></w:r><w:del w:id="500" w:author="Counsel" w:date="D"><w:r><w:delText>clause.</w:delText></w:r></w:del></w:ins></w:p>');
  assert.deepEqual(applyDecisions(struck, [{ id: 's', part: PART, revisionIds: [60, 61], decision: 'rejected' }]).results, [{ id: 's', status: 'blocked', reason: 'nested_change' }]);
  // The lawyer reads it as Needs Word, with the sentence.
  assert.equal(PLACEMENT_TEXT.nested_change, 'A later change was made inside this one. Decide the later change first.');
  const row = { id: 'x', review_type: 'edit', op: 'replace', part: PART, status: 'pending', placement: 'blocked', placement_reason: 'nested_change', created_at: 'T' };
  assert.equal(stateOf(row), 'needs_word');
  const card = cardFor(row, { number: 1 });
  assert.deepEqual([card.stateLabel, card.stateNote, card.canAccept, card.canReject], ['Needs Word', PLACEMENT_TEXT.nested_change, false, false]);
});

test('a split of the AI\'s own insertion within one call is recorded on the earlier change', () => {
  const bytes = docFrom('<w:p><w:r><w:t xml:space="preserve">4. The fee is thirty (30) days payable by Party Alpha.</w:t></w:r></w:p>');
  const out = applyReviewSuggestions(bytes, [
    { id: 0, original: '<p>thirty (30) days</p>', suggested: '<p>forty five (45) business days</p>', accepted: false },
    { id: 1, original: '<p>five (45)</p>', suggested: '<p>six (46)</p>', accepted: false },
  ]);
  const [r0, r1] = out.results;
  assert.deepEqual(out.results.map((r) => r.status), ['applied', 'applied']);
  assert.equal(r1.splits.length, 1);
  assert.ok(r0.revisionIds.includes(r1.splits[0].fromId), 'the split container is the first change\'s insertion');
  assert.ok(r0.revisionIds.includes(r1.splits[0].toId), 'the second half\'s fresh id is the first change\'s too');
  assert.ok(!r1.revisionIds.includes(r1.splits[0].toId));
  assert.equal(findRevisions(out.bytes).ours.size, r0.revisionIds.length + r1.revisionIds.length);
  const rej = applyDecisions(out.bytes, [
    { id: '0', part: PART, revisionIds: r0.revisionIds, decision: 'rejected' },
    { id: '1', part: PART, revisionIds: r1.revisionIds, decision: 'rejected' },
  ]);
  assert.deepEqual(rej.results.map((r) => r.status), ['applied', 'applied']);
  assert.equal(findRevisions(rej.bytes).ours.size, 0, 'rejecting both leaves no AKLA AI revision');
  assert.equal([...inspectDocx(rej.bytes).byRef.values()][0].exactText, '4. The fee is thirty (30) days payable by Party Alpha.');
});

test('a cell that ends in a nested table gets its closing paragraph back', async () => {
  const bytes = docFrom('<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner.</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Trailing.</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Body.</w:t></w:r></w:p>');
  const view = inspectDocx(bytes);
  const [p] = [...view.byRef].find(([, r]) => r.exactText === 'Trailing.');
  const out = await applyDocxOps(bytes, [{ op: 'delete', p, expected: 'Trailing.' }], view.byRef);
  const want = '<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner.</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr></w:tbl>';
  const dec = applyDecisions(out.bytes, [{ id: 'd', part: PART, revisionIds: out.results[0].revisionIds, decision: 'accepted' }]);
  assert.deepEqual(dec.results, [{ id: 'd', status: 'applied' }]);
  assert.ok(docXml(dec.bytes).includes(want), 'the outer cell ends with a paragraph again');
  assert.ok(docXml(acceptAllChanges(out.bytes)).includes(want));
  assert.ok(docXml(acceptChangesBy(out.bytes)).includes(want));
  // A cell that already ends in a paragraph, with or without content, is left alone.
  const fine = docFrom('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p> </w:tc><w:tc><w:p w:rsidR="1"/></w:tc></w:tr></w:tbl>');
  assert.equal(docXml(acceptAllChanges(fine)), docXml(fine));
});

test('the same decision always gives the same bytes, and the reported hash is of the bytes returned', async () => {
  const f = await fixture();
  const a = applyDecisions(f.bytes, [f.replaceA('accepted')]);
  await new Promise((r) => setTimeout(r, 30));
  const b = applyDecisions(f.bytes, [f.replaceA('accepted')]);
  assert.deepEqual(Buffer.from(a.bytes), Buffer.from(b.bytes), 'byte-identical, whatever the clock says');
  const bytes = docFrom(FIXTURE_BODY);
  const out = await applyDocxOps(bytes, [{ op: 'replace', p: 1, expected: 'Party Alpha pays 10.', text: 'Party Beta pays 20.' }], inspectDocx(bytes).byRef);
  const { createHash } = await import('node:crypto');
  assert.equal(out.validation.outputHash, createHash('sha256').update(out.bytes).digest('hex'));
});

test('cards of one turn are numbered in document order', () => {
  const row = (id, extra) => ({ id, review_type: 'edit', op: 'replace', part: PART, status: 'pending', placement: 'placed', created_at: '2026-10-14T10:00:00Z', paragraph_index: 1, ...extra });
  const rows = [
    row('z', { paragraph_index: 7 }),
    row('y', { paragraph_index: 2, part: 'word/header1.xml' }),
    row('x', { paragraph_index: 2 }),
    row('w', { paragraph_index: null }),
    row('v', { paragraph_index: 2 }),
    row('u', { created_at: '2026-10-14T09:00:00Z', paragraph_index: 99 }),
  ];
  assert.deepEqual(cardsFor(rows).map((c) => [c.number, c.id]), [[1, 'u'], [2, 'v'], [3, 'x'], [4, 'y'], [5, 'z'], [6, 'w']]);
});
