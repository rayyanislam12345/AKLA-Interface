import test from 'node:test';
import assert from 'node:assert/strict';

// The tab's storage, as the browser keeps it: one per test, fresh.
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}
globalThis.sessionStorage = fakeStorage();

const { embedHostFor, resolveCompanionHost, resolveEmbedHost, resolveEmbedMode, resolvePaneHost, withEmbed, withoutEmbed } = await import('../src/lib/embedMode.ts');

/** Who shows the page, as the workspace works it out from an address. */
const hostOf = (search) => embedHostFor(resolveEmbedMode(search), resolveEmbedHost(search));

test('the pane page: ?embed=1&host=pane, kept for the tab once seen', () => {
  sessionStorage.clear();
  assert.equal(hostOf('?embed=1&host=pane'), 'pane');
  assert.equal(resolvePaneHost('?embed=1&host=pane'), true);
  assert.equal(resolveCompanionHost('?embed=1&host=pane'), false);
  // Links inside the app carry neither flag; the tab remembers both.
  assert.equal(hostOf(''), 'pane');
  assert.equal(hostOf('?open=v:abc'), 'pane');
});

test('the companion: ?embed=1&host=companion, unchanged (still stored as "1")', () => {
  sessionStorage.clear();
  assert.equal(hostOf('?embed=1&host=companion'), 'companion');
  assert.equal(sessionStorage.getItem('hub-embed-host'), '1');
  assert.equal(resolveCompanionHost(''), true);
  assert.equal(resolvePaneHost(''), false);
  assert.equal(hostOf(''), 'companion');
});

test('the plain Hub: no flags, embed without a host, or embed switched off', () => {
  sessionStorage.clear();
  assert.equal(hostOf(''), null);
  assert.equal(hostOf('?embed=1'), null, 'the old embed mode (one-line header) names no host');
  sessionStorage.clear();
  assert.equal(hostOf('?embed=1&host=pane'), 'pane');
  // "Full Hub" opens the same page with ?embed=0: no host counts without embed mode.
  assert.equal(hostOf('?embed=0'), null);
  assert.equal(hostOf(''), null);
  // Any other host clears the stored one.
  sessionStorage.clear();
  assert.equal(hostOf('?embed=1&host=pane'), 'pane');
  assert.equal(hostOf('?embed=1&host=elsewhere'), null);
});

test('the last host named wins: a pane link after the companion, and back', () => {
  sessionStorage.clear();
  assert.equal(hostOf('?embed=1&host=companion'), 'companion');
  assert.equal(hostOf('?embed=1&host=pane'), 'pane');
  assert.equal(hostOf(''), 'pane');
  assert.equal(hostOf('?embed=1&host=companion'), 'companion');
});

test('without storage (a private window) the address alone decides', () => {
  const saved = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  try {
    assert.equal(hostOf('?embed=1&host=pane'), 'pane');
    assert.equal(hostOf('?embed=1&host=companion'), 'companion');
    assert.equal(hostOf(''), null);
  } finally {
    globalThis.sessionStorage = saved;
  }
});

test('the sign-in round trip keeps the pane flags; "Full Hub" drops them', () => {
  assert.equal(withEmbed('/ai/d/abc'), '/ai/d/abc?embed=1');
  assert.equal(withEmbed('/ai/d/abc', 'pane'), '/ai/d/abc?embed=1&host=pane');
  assert.equal(withEmbed('/ai/d/abc?embed=1&host=pane', 'pane'), '/ai/d/abc?embed=1&host=pane');
  assert.equal(withoutEmbed('/ai/d/abc?embed=1&host=pane'), '/ai/d/abc?embed=0');
  assert.equal(withoutEmbed('/ai/p/p1?open=v%3Aabc&embed=1&host=pane#x'), '/ai/p/p1?open=v%3Aabc&embed=0#x');
});
