import test from 'node:test';
import assert from 'node:assert/strict';
import { versionForClaudeText, instructionsForClaudeText, recentVersions } from '../src/lib/copyForClaude.ts';

test('a version is copied with its name, id and Hub address', () => {
  const text = versionForClaudeText({ title: 'Concession Agreement', versionId: 'abc', versionNumber: 3, fileName: 'CA v3.docx', projectName: 'Corridor' }, 'https://hub.example');
  assert.equal(text, 'Hub document: Concession Agreement, v3 (CA v3.docx) in project Corridor\nversionId: abc\nOpen in Hub: https://hub.example/ai/d/abc');
});

test('a version without a file name or project leaves them out', () => {
  const text = versionForClaudeText({ title: 'Memo', versionId: 'x', versionNumber: 1 }, 'https://hub.example');
  assert.equal(text.split('\n')[0], 'Hub document: Memo, v1');
});

test('standing instructions are named for their project, trimmed', () => {
  assert.equal(instructionsForClaudeText('Corridor', '  Use UK spelling.\nCite the Act.  \n'), 'Standing instructions for project Corridor:\n\nUse UK spelling.\nCite the Act.');
});

test('no instructions, or only blank space, copies nothing', () => {
  assert.equal(instructionsForClaudeText('Corridor', ''), null);
  assert.equal(instructionsForClaudeText('Corridor', '   \n'), null);
  assert.equal(instructionsForClaudeText('Corridor', null), null);
  assert.equal(instructionsForClaudeText('Corridor', undefined), null);
});

test('recent activity is the newest versions across documents, newest first, up to the limit', () => {
  const v = (id, n, at) => ({ id, version_number: n, created_at: at });
  const docs = [
    { id: 'd1', versions: [v('a1', 1, '2026-10-01T09:00:00Z'), v('a2', 2, '2026-10-05T09:00:00Z')] },
    { id: 'd2', versions: [v('b1', 1, '2026-10-03T09:00:00Z')] },
    { id: 'd3', versions: null },
    { id: 'd4' },
    { id: 'd5', versions: [v('c1', 1, '2026-10-06T09:00:00Z')] },
  ];
  const rows = recentVersions(docs, 3);
  assert.deepEqual(rows.map((r) => r.version.id), ['c1', 'a2', 'b1']);
  assert.equal(rows[1].doc.id, 'd1');
  assert.deepEqual(recentVersions(docs).map((r) => r.version.id), ['c1', 'a2', 'b1', 'a1']);
  assert.deepEqual(recentVersions([], 5), []);
  assert.deepEqual(recentVersions(docs, 0), []);
});

test('versions added at the same moment put the higher number first', () => {
  const at = '2026-10-01T09:00:00Z';
  const rows = recentVersions([{ versions: [{ id: 'v1', version_number: 1, created_at: at }, { id: 'v2', version_number: 2, created_at: at }] }]);
  assert.deepEqual(rows.map((r) => r.version.id), ['v2', 'v1']);
});

test('a project is copied with its name, id and Hub address (the pane bar on a project page)', async () => {
  const { projectForClaudeText } = await import('../src/lib/copyForClaude.ts');
  assert.equal(
    projectForClaudeText({ name: 'M6 Motorway', matterId: 'p1' }, 'https://hub.example'),
    'Hub project: M6 Motorway\nprojectId: p1\nOpen in Hub: https://hub.example/ai/p/p1',
  );
});
