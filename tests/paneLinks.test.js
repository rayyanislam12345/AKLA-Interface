import test from 'node:test';
import assert from 'node:assert/strict';
import { PANE_QUERY, hubLink, openInHub } from '../chat-service/connector/hubLinks.js';

// The connector's "Open in Hub" links open the pane page (the Claude desktop
// app's browser pane), and the companion extension still knows them as Hub
// links and opens them in its drawer without the pane's flags.
await import('../hub-companion/links.js');
const L = globalThis.HubLinks;
const HUB = 'https://akla-interface.vercel.app';
const V = '0c1f77aa-1111-4222-8333-444455556666';

test('project and version links carry ?embed=1&host=pane; the precedent library stays plain', () => {
  assert.equal(PANE_QUERY, '?embed=1&host=pane');
  assert.equal(hubLink('version', V), `${HUB}/ai/d/${V}?embed=1&host=pane`);
  assert.equal(hubLink('project', 'p1', 'https://hub.test/'), 'https://hub.test/ai/p/p1?embed=1&host=pane');
  assert.equal(openInHub('version', V, HUB), `Open in Hub: ${HUB}/ai/d/${V}?embed=1&host=pane`);
  assert.equal(hubLink('precedents', null, HUB), `${HUB}/precedent-library`);
});

test('the companion finds a pane link in a reply and opens it in its drawer as its own', () => {
  const link = hubLink('version', V);
  const text = `Saved as v2.\nOpen in Hub: ${link}\nAnything else?`;
  const found = L.findHubUrls(text, HUB);
  assert.equal(found.length, 1);
  assert.equal(found[0].url, `${HUB}/ai/d/${V}`, 'the pane flags are dropped (FRAME_PARAMS)');
  assert.equal(text.slice(found[0].index, found[0].index + found[0].length), link, 'the whole address is the link, flags and all');
  assert.equal(L.linkKind(found[0].url), 'document');
  // As an <a href> in claude.ai's reply.
  assert.equal(L.normaliseHubUrl(link, HUB), `${HUB}/ai/d/${V}`);
  assert.equal(L.normaliseHubUrl(hubLink('project', 'p1'), HUB), `${HUB}/ai/p/p1`);
  assert.equal(L.linkKind(L.normaliseHubUrl(hubLink('project', 'p1'), HUB)), 'project');
  // The drawer's frame is the companion's, never the pane's.
  const framed = new URL(L.embedUrl(L.normaliseHubUrl(link, HUB)));
  assert.equal(framed.searchParams.get('host'), 'companion');
  assert.equal(framed.searchParams.get('embed'), '1');
  // "Open in a tab" from the drawer is the plain page.
  assert.equal(L.plainUrl(link), `${HUB}/ai/d/${V}`);
});
