import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDocumentsByCategory, latestVersionOf, attachmentForVersion, NO_TYPE_GROUP } from '../src/lib/projectFiles.ts';

const types = [
  { id: 't-ca', name: 'Concession Agreement', category: 'Agreements' },
  { id: 't-dd', name: 'Due Diligence Report', category: 'Reports' },
  { id: 't-sha', name: 'Shareholders Agreement', category: 'Agreements' },
];
const v = (id, n, created = '2026-10-01') => ({ id, version_number: n, created_at: created, storage_path: `m/${id}.docx`, file_name: `${id}.docx` });

test('documents are grouped by their type category, in the library order, untyped last', () => {
  const docs = [
    { id: 'd1', title: 'DD Volume I', document_type_id: 't-dd', versions: [v('v1', 1), v('v2', 2)] },
    { id: 'd2', title: 'Scan', document_type_id: null, versions: [v('v3', 1)] },
    { id: 'd3', title: 'Concession Agreement', document_type_id: 't-ca', versions: [] },
    { id: 'd4', title: 'SHA', document_type_id: 't-sha', versions: null },
  ];
  const groups = groupDocumentsByCategory(docs, types);
  assert.deepEqual(groups.map((g) => g.category), ['Agreements', 'Reports', NO_TYPE_GROUP]);
  assert.deepEqual(groups[0].documents.map((d) => d.doc.id), ['d3', 'd4']);
  assert.equal(groups[0].documents[0].typeName, 'Concession Agreement');
  assert.equal(groups[0].documents[0].latest, null);
  assert.equal(groups[1].documents[0].latest.id, 'v2');
  assert.equal(groups[2].documents[0].typeName, null);
});

test('a type the library no longer lists goes after the known categories but before untyped', () => {
  const docs = [
    { id: 'd1', title: 'A', document_type_id: 'gone', versions: [] },
    { id: 'd2', title: 'B', document_type_id: null, versions: [] },
    { id: 'd3', title: 'C', document_type_id: 't-ca', versions: [] },
  ];
  const groups = groupDocumentsByCategory(docs, types);
  assert.deepEqual(groups.map((g) => g.category), ['Agreements', NO_TYPE_GROUP]);
  // The unknown type reads as untyped.
  assert.deepEqual(groups[1].documents.map((d) => d.doc.id), ['d1', 'd2']);
});

test('the latest version is by number, not by order', () => {
  assert.equal(latestVersionOf([v('a', 2), v('b', 5), v('c', 3)]).id, 'b');
  assert.equal(latestVersionOf([]), null);
  assert.equal(latestVersionOf(null), null);
});

test('a stored version becomes the attachment the chat server reads', () => {
  const att = attachmentForVersion({ id: 'd1', title: 'DD Volume I' }, v('v2', 2));
  assert.deepEqual(att, { bucket: 'matter-documents', path: 'm/v2.docx', name: 'v2.docx', matterDocumentId: 'd1', versionId: 'v2' });
  assert.equal(attachmentForVersion({ id: 'd1', title: 'DD Volume I' }, { ...v('v2', 2), file_name: null }).name, 'DD Volume I v2');
});
