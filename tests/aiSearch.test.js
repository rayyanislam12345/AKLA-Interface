import test from 'node:test';
import assert from 'node:assert/strict';
import { likePattern, searchable, newestVersionId, searchResultPath, MIN_SEARCH_LENGTH } from '../src/lib/aiSearch.ts';

test('a query is searched from two letters, after trimming', () => {
  assert.equal(MIN_SEARCH_LENGTH, 2);
  assert.equal(searchable(''), false);
  assert.equal(searchable(' a '), false);
  assert.equal(searchable('ab'), true);
});

test('the ilike pattern escapes the wildcards a title might contain', () => {
  assert.equal(likePattern('concession'), '%concession%');
  assert.equal(likePattern('  100% done_ '), '%100\\% done\\_%');
  assert.equal(likePattern('a\\b'), '%a\\\\b%');
});

test('the newest version is by number, with none for a document without a file', () => {
  assert.equal(newestVersionId([{ id: 'a', version_number: 1 }, { id: 'b', version_number: 3 }, { id: 'c', version_number: 2 }]), 'b');
  assert.equal(newestVersionId([]), null);
  assert.equal(newestVersionId(null), null);
});

test('each kind of result opens in the right place', () => {
  assert.equal(searchResultPath({ kind: 'chat', id: 't1' }), '/ai/c/t1');
  assert.equal(searchResultPath({ kind: 'project', id: 'm1' }), '/ai/p/m1');
  assert.equal(searchResultPath({ kind: 'document', matterId: 'm1', latestVersionId: 'v9' }), '/ai/p/m1?open=v:v9');
  assert.equal(searchResultPath({ kind: 'document', matterId: 'm1', latestVersionId: null }), '/ai/p/m1');
});
