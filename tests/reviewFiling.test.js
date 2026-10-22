import test from 'node:test';
import assert from 'node:assert/strict';
// Node strips the types from this file itself, so the tests run against the
// very rules the review panel uses.
import { filingOf, reviewView, filingHeadline } from '../src/lib/reviewFilingRules.ts';

const filed = { status: 'filed', versionId: 'v2-id', versionNumber: 2, reviewedVersionNumber: 1, placed: 3, waiting: 3, notPlaced: [{ suggestionId: 's4', reason: 'not_found' }] };

test('the filing record is read from the run\'s coverage, and nothing else is taken for one', () => {
  assert.deepEqual(filingOf({ documentCharacters: 10, filing: filed }), filed);
  assert.equal(filingOf({ documentCharacters: 10 }), null);
  assert.equal(filingOf(null), null);
  assert.equal(filingOf({ filing: { versionId: 'x' } }), null, 'a record without a status is not one');
});

test('a filed review shows the filed version; one the document moved past is for reading; anything else keeps the review\'s own list', () => {
  assert.equal(reviewView(filed), 'filed');
  assert.equal(reviewView({ ...filed, versionId: undefined }), 'interactive', 'no version to show: the list');
  assert.equal(reviewView({ status: 'newer_version', latestVersionNumber: 2, reviewedVersionNumber: 1 }), 'read-only');
  for (const status of ['not_word', 'failed', 'format_refused', 'none_placed', 'nothing_found']) assert.equal(reviewView({ status }), 'interactive', status);
  assert.equal(reviewView(null), 'interactive', 'a review from before filing');
});

test('the panel says where the review went in one line', () => {
  assert.equal(filingHeadline(filed), 'Filed as v2: 3 changes waiting in its Changes list below. 1 finding could not be placed and is listed for reading.');
  assert.equal(filingHeadline({ ...filed, waiting: 1, notPlaced: [] }), 'Filed as v2: 1 change waiting in its Changes list below.');
  assert.match(filingHeadline({ status: 'newer_version', latestVersionNumber: 3, reviewedVersionNumber: 2 }), /^Not filed: v3 was saved while the review ran, and these findings quote v2's words, so nothing was placed over it\./);
  assert.match(filingHeadline({ status: 'failed', note: 'storage was down' }), /^Not filed: storage was down\.$/);
  assert.equal(filingHeadline({ status: 'nothing_found' }), null);
  assert.equal(filingHeadline(null), null);
});
