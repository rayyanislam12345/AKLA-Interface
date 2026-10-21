import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionMessage, tidyPassage, PASSAGE_LIMIT } from '../src/lib/selectionPassage.ts';

test('a highlighted passage is kept as shown, tidied at the edges', () => {
  assert.deepEqual(tidyPassage('  14.2 The Seller  \r\n\r\n\r\nshall indemnify\u00a0the Buyer.\n'), {
    text: '14.2 The Seller\n\nshall indemnify the Buyer.',
    truncated: false,
  });
  assert.deepEqual(tidyPassage(' \n '), { text: '', truncated: false });
});

test('a long passage is cut with … at the limit', () => {
  const t = tidyPassage('a'.repeat(PASSAGE_LIMIT + 50));
  assert.equal(t.truncated, true);
  assert.equal(t.text, `${'a'.repeat(PASSAGE_LIMIT)}…`);
});

// The pane page copies the passage itself; the companion builds it from the
// Hub's post with hub-companion/passage.js. Both must give the chat the same text.
await import('../hub-companion/passage.js');
const companion = globalThis.HubPassage;

const posts = [
  { text: '14.2 The Seller shall indemnify the Buyer.', truncated: false, title: 'Share Purchase Agreement', versionId: '0c1f-77aa', versionNumber: 3, fileName: 'SPA v3.docx', projectName: 'Project Falcon' },
  { text: '  First line  \r\n\r\n\r\nSecond\u00a0line\n', truncated: false, title: '', versionId: 'v1', versionNumber: 0, fileName: null, projectName: null },
  { text: 'x'.repeat(PASSAGE_LIMIT + 10), truncated: true, title: 'Long', versionId: 'v2', versionNumber: 12, fileName: '', projectName: 'P' },
  { text: tidyPassage('y '.repeat(PASSAGE_LIMIT)).text, truncated: true, title: 'Cut by the Hub', versionId: 'v3', versionNumber: 1, fileName: 'a.docx', projectName: null },
  { text: '   ', truncated: false, title: 'Empty', versionId: 'v4', versionNumber: 1, fileName: null, projectName: null },
  { text: 'No version', truncated: false, title: 'T', versionId: '', versionNumber: 1, fileName: null, projectName: null },
];

test('the pane page and the companion make the identical message from the same passage', () => {
  for (const post of posts) {
    assert.equal(selectionMessage(post), companion.selectionMessage({ type: 'hub:selection', ...post }), JSON.stringify(post).slice(0, 80));
  }
  assert.equal(companion.LIMIT, PASSAGE_LIMIT);
});

test('the copied message reads as the companion puts it in the chat', () => {
  assert.equal(
    selectionMessage(posts[0]),
    'In "Share Purchase Agreement" v3 (SPA v3.docx), project Project Falcon — versionId: 0c1f-77aa\n> 14.2 The Seller shall indemnify the Buyer.\n\n',
  );
  assert.equal(selectionMessage(posts[1]), 'In "Untitled document" — versionId: v1\n> First line\n>\n> Second line\n\n');
  assert.match(selectionMessage(posts[2]), /…\n\(Only the first 4,000 characters of the passage are quoted\.\)\n\n$/);
  assert.equal(selectionMessage(posts[4]), null);
  assert.equal(selectionMessage(posts[5]), null);
});
