import test from 'node:test';
import assert from 'node:assert/strict';
// Node strips the types from this file itself, so the tests run against the
// very rules the browser uses.
import {
  autoSaveEligible,
  chooseExpectedVersionId,
  headerFacts,
  pickClientKeys,
  plainSaveError,
  saveButtonLabel,
  saveStateOf,
  saveTargetFor,
  savedMessage,
  versionLabelFor,
} from '../src/lib/documentSaveRules.ts';

const opened = { matterDocumentId: 'doc-1', documentVersionId: 'v4', versionNumber: 4, title: 'Share Purchase Agreement' };

test('a version is labelled as an AI draft from the chat with the date, unless the lawyer gives a label', () => {
  const date = new Date(2026, 9, 16);
  assert.equal(versionLabelFor(undefined, date), 'AI draft from chat — 16 October 2026');
  assert.equal(versionLabelFor('   ', date), 'AI draft from chat — 16 October 2026');
  assert.equal(versionLabelFor('  For partner review ', date), 'For partner review');
});

test('the base version: what this chat last saved, else what it was opened from', () => {
  assert.equal(chooseExpectedVersionId({ head: { editSource: opened } }), 'v4');
  assert.equal(chooseExpectedVersionId({ head: { editSource: opened, savedVersionId: 'v5', savedVersion: 5 } }), 'v5');
  // The head does not carry the save (a copy written before the save landed):
  // the newest save on any copy of the same document is the base.
  const lineage = [{ editSource: opened, savedVersionId: 'v5', savedVersion: 5 }, { editSource: opened, savedVersionId: 'v6', savedVersion: 6 }];
  assert.equal(chooseExpectedVersionId({ head: { editSource: opened }, lineage }), 'v6');
  // The project's latest version is one this chat made: it is the base.
  assert.equal(chooseExpectedVersionId({ head: { editSource: opened }, lineage, latestVersionId: 'v6' }), 'v6');
  assert.equal(chooseExpectedVersionId({ head: { editSource: opened }, latestVersionId: 'v4' }), 'v4');
  // A colleague's newer version is never taken as the base: the save is refused instead.
  assert.equal(chooseExpectedVersionId({ head: { editSource: opened }, latestVersionId: 'colleague-v5' }), 'v4');
  // Nothing to go on (a new document, or the firm's standard).
  assert.equal(chooseExpectedVersionId({ head: { editSource: { standard: true, title: 'Standard' } } }), null);
  assert.equal(chooseExpectedVersionId({ head: {} }), null);
});

test('the document a new version is added to', () => {
  assert.equal(saveTargetFor({ editSource: opened }), 'doc-1');
  assert.equal(saveTargetFor({ editSource: opened, savedMatterDocumentId: 'doc-2' }), 'doc-2');
  assert.equal(saveTargetFor({ editSource: { standard: true, title: 'Standard' } }), null);
  assert.equal(saveTargetFor({}), null);
});

test('where the head stands against the project', () => {
  assert.equal(saveStateOf({ storagePath: 'a.docx', producedBy: 'turn' }), 'unsaved');
  assert.equal(saveStateOf({ storagePath: 'a.docx', producedBy: 'turn', savedVersion: 5, savedVersionId: 'v5', savedStoragePath: 'a.docx' }), 'saved');
  // A later copy inherits the saved keys but not the path that was saved.
  assert.equal(saveStateOf({ storagePath: 'b.docx', producedBy: 'decision', savedVersion: 5, savedVersionId: 'v5', savedStoragePath: 'a.docx' }), 'changed-since-save');
  assert.equal(saveStateOf({ storagePath: 'c.docx', producedBy: 'turn', savedVersion: 5, savedVersionId: 'v5' }), 'changed-since-save');
  // Saved before saves recorded their file: the copy itself was saved.
  assert.equal(saveStateOf({ storagePath: 'old.docx', savedVersion: 3, savedVersionId: 'v3' }), 'saved');
  assert.equal(saveStateOf({ storagePath: 'p/v4.docx', bucket: 'matter-documents', producedBy: 'open', editSource: opened }), 'unchanged');
});

test('buttons and messages say what a save will do and what it did', () => {
  assert.equal(saveButtonLabel({ mode: 'next-version', nextVersion: 5 }), 'Save as v5');
  assert.equal(saveButtonLabel({ mode: 'next-version', nextVersion: 5, waiting: 3 }), 'Save as v5 · 3 changes waiting');
  assert.equal(saveButtonLabel({ mode: 'next-version', waiting: 1 }), 'Save new version · 1 change waiting');
  assert.equal(saveButtonLabel({ mode: 'new-document' }), 'Save to project as a new document');
  assert.equal(saveButtonLabel({ mode: 'next-version', nextVersion: 2, truncated: true }), 'Save incomplete draft as v2');
  assert.equal(savedMessage({ versionNumber: 5, waiting: 3 }), 'Saved as v5 · 3 changes still waiting as tracked changes');
  assert.equal(savedMessage({ versionNumber: 5 }), 'Saved as v5');
  assert.equal(savedMessage({ versionNumber: 1, newDocument: true }), 'Saved to the project as a new document (v1)');
});

test('only an AI turn\'s copy of a project document is saved automatically, and only in a project chat', () => {
  const copy = { producedBy: 'turn', editSource: opened, storagePath: 'a.docx' };
  assert.equal(autoSaveEligible(copy, { inProject: true }), true);
  assert.equal(autoSaveEligible(copy, { inProject: false }), false);
  assert.equal(autoSaveEligible({ ...copy, producedBy: 'decision' }, { inProject: true }), false);
  assert.equal(autoSaveEligible({ ...copy, producedBy: 'open' }, { inProject: true }), false);
  assert.equal(autoSaveEligible({ ...copy, editSource: null }, { inProject: true }), false);
  assert.equal(autoSaveEligible({ ...copy, truncated: true }, { inProject: true }), false);
  assert.equal(autoSaveEligible({ ...copy, standard: true }, { inProject: true }), false);
  assert.equal(autoSaveEligible({ ...copy, editSource: { standard: true, title: 'Standard' } }, { inProject: true }), false);
});

test('the client writes only its own keys into an artifact', () => {
  assert.deepEqual(pickClientKeys({ savedVersion: 5, savedVersionId: 'v5', storagePath: 'x', changeCounts: {}, documentTypeId: null }), {
    savedVersion: 5,
    savedVersionId: 'v5',
    documentTypeId: null,
  });
});

test('the panel header says where the document stands', () => {
  const data = { producedBy: 'turn', storagePath: 'b.docx', editSource: opened, savedVersion: 5, savedVersionId: 'v5', savedStoragePath: 'a.docx' };
  assert.deepEqual(headerFacts({ data, projectName: 'Port Qasim', inProject: true, waiting: 2 }), [
    'Port Qasim',
    'opened from v4 of Share Purchase Agreement',
    'unsaved changes since v5',
    '2 waiting',
  ]);
  assert.deepEqual(headerFacts({ data: { producedBy: 'turn', storagePath: 'a.docx' }, projectName: null, inProject: false, waiting: 0 }), ['not in a project', 'not saved yet']);
});

test('save failures read as sentences, and none trips the upload panel\'s own rewording', () => {
  assert.match(plainSaveError(new Error('A newer document version exists. Reopen the latest version before saving these edits.')), /Someone saved a newer version/);
  assert.match(plainSaveError({ message: 'Document does not belong to this project and type' }), /type was changed/);
  assert.match(plainSaveError(new TypeError('Failed to fetch')), /Check your connection/);
  assert.match(plainSaveError({ message: 'Forbidden' }), /sign-in has expired/);
  assert.equal(plainSaveError(new Error('That document is no longer in the project.')), 'That document is no longer in the project.');
  // src/components/documents/uploadErrors.ts rewrites messages containing these.
  const uploadPhrases = ['failed to fetch', 'network', 'load failed', 'payload', 'newer document version', 'does not belong to this project and type', 'jwt', 'not authenticated', 'forbidden', 'invalid file name'];
  for (const raw of ['A newer document version exists.', 'Document does not belong to this project and type', 'Failed to fetch', 'Forbidden', 'Invalid file name', 'invalid JWT']) {
    const sentence = plainSaveError(new Error(raw)).toLowerCase();
    for (const phrase of uploadPhrases) assert.ok(!sentence.includes(phrase), `"${sentence}" contains "${phrase}"`);
  }
});
