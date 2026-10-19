// The connector's OAuth flow end to end, without the network: the app
// (connector/app.js) over a memory store, a stubbed sign-in and no tools,
// driven with fetch. Register -> authorize with PKCE -> code -> token ->
// refresh -> revoke; a wrong password; an unapproved user; a PKCE mismatch;
// the rate limit on the sign-in form; what /mcp says without a token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createApp, SIGN_IN_LIMIT } from '../connector/app.js';
import { createMemoryStore } from '../connector/store.js';
import { ACCESS_TTL_S, CODE_TTL_S, DEFAULT_SCOPE, KNOWN_SCOPES, READ_SCOPE, REFRESH_GRACE_S, hostAllowed, metadata, pkceMatches, scopeOf, sha256, validRedirectUri } from '../connector/oauth.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PENDING = '22222222-2222-4222-8222-222222222222';
const TOTP_USER = '33333333-3333-4333-8333-333333333333';

// A sign-in that knows three accounts: a member, one awaiting approval, and
// one with an authenticator app.
async function fakeSignIn({ email, password, totp }) {
  if (email === 'lawyer@akla.com.pk' && password === 'right') return { ok: true, userId: USER, email };
  if (email === 'new@akla.com.pk' && password === 'right') return { ok: false, reason: 'not_member', message: 'Your Hub account is not an approved member of the firm, so it cannot use the connector. Ask an administrator to approve it.' };
  if (email === 'totp@akla.com.pk' && password === 'right') {
    if (!totp) return { ok: false, reason: 'needs_totp', message: 'Your account uses an authenticator app. Enter the 6-digit code from it.' };
    if (totp !== '123456') return { ok: false, reason: 'bad_totp', message: 'That authenticator code is wrong or has expired. Try the next one.' };
    return { ok: true, userId: TOTP_USER, email };
  }
  return { ok: false, reason: 'bad_password', message: 'That email or password is wrong.' };
}

function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function start({ members = new Set([USER, TOTP_USER]), clock, allowLoopback, redirectHosts, store = createMemoryStore(), log = () => {} } = {}) {
  const app = createApp({
    store, signIn: fakeSignIn, tools: [], issuer: 'https://hub.test',
    isMember: async (id) => members.has(id),
    allowLoopback, redirectHosts,
    now: () => new Date(clock.ms), log,
  });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
  const form = (path, fields, headers = {}) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
  const json = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { store, server, base, call, form, json, close: () => new Promise((r) => server.close(r)) };
}

async function register(t, extra = {}) {
  const r = await t.json('/oauth/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], ...extra });
  assert.equal(r.status, 201);
  return r.json();
}

function authorizeUrl(client, { challenge, state = 'xyz', ...rest } = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256', state, scope: DEFAULT_SCOPE, ...rest });
  return `/oauth/authorize?${q}`;
}

const formFields = (client, challenge, extra) => ({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: DEFAULT_SCOPE, ...extra });

test('the discovery documents point claude.ai at the endpoints', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const t = await start({ clock });
  try {
    const as = await (await t.call('/.well-known/oauth-authorization-server')).json();
    assert.equal(as.issuer, 'https://hub.test');
    assert.equal(as.authorization_endpoint, 'https://hub.test/oauth/authorize');
    assert.equal(as.token_endpoint, 'https://hub.test/oauth/token');
    assert.equal(as.registration_endpoint, 'https://hub.test/oauth/register');
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.scopes_supported, ['hub:read', 'hub:write'], 'both permissions are advertised');
    const pr = await (await t.call('/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(pr.resource, 'https://hub.test/mcp');
    assert.deepEqual(pr.authorization_servers, ['https://hub.test']);
    assert.deepEqual(pr.scopes_supported, [...KNOWN_SCOPES]);
    assert.deepEqual(metadata('https://hub.test/').authorizationServer.issuer, 'https://hub.test');
    const about = await t.call('/oauth/about');
    assert.equal(about.status, 200);
    assert.match(await about.text(), /Customize/);
  } finally { await t.close(); }
});

test('register, sign in with PKCE, exchange the code, refresh, revoke', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const t = await start({ clock });
  try {
    const client = await register(t);
    assert.match(client.client_id, /^akh_c_/);
    assert.equal(client.client_secret, undefined, 'a public client gets no secret');
    assert.equal(client.token_endpoint_auth_method, 'none');

    // Without a token, /mcp says where to sign in: the path-inserted
    // protected-resource document for /mcp (RFC 9728 §3), whose `resource`
    // is the /mcp URL itself.
    const bare = await t.json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(bare.status, 401);
    assert.match(bare.headers.get('www-authenticate'), /resource_metadata="https:\/\/hub\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
    // The challenge names both scopes, so claude.ai asks for both (its docs: the challenge's scope wins).
    assert.match(bare.headers.get('www-authenticate'), /scope="hub:read hub:write"/);
    const prm = await (await t.call('/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(prm.resource, 'https://hub.test/mcp');

    const { verifier, challenge } = pkce();
    const page = await t.call(authorizeUrl(client, { challenge }));
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.match(body, /Sign in to AKLA Hub/);
    assert.match(body, /name="code_challenge" value="/);
    assert.match(body, /<strong>Claude<\/strong>/);
    assert.match(body, /sent back to <strong>claude\.ai<\/strong>/, 'the page names the address the lawyer will be sent to');
    assert.match(body, /save new versions into projects as you/, 'a sign-in that grants hub:write says so');
    assert.match(body, /asks you before every save/);
    assert.match(body, /never replaces or deletes anything/);
    assert.match(body, /Needs approval/, 'and tells the lawyer about Research mode');
    assert.doesNotMatch(body, /<script/i);

    // The sign-in form posts the parameters back with the credentials.
    const ok = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    assert.equal(ok.status, 302);
    const back = new URL(ok.headers.get('location'));
    assert.equal(`${back.origin}${back.pathname}`, client.redirect_uris[0]);
    assert.equal(back.searchParams.get('state'), 'xyz');
    const code = back.searchParams.get('code');
    assert.match(code, /^akh_a_/);
    // Only the hash is stored.
    assert.ok(t.store.codes.has(sha256(code)));
    assert.ok(![...t.store.codes.keys()].includes(code));
    assert.equal([...t.store.codes.values()][0].user_id, USER);

    // The wrong verifier is refused, and does not spend the code? It does:
    // a code is single use whatever happened (OAuth 2.1), so we take a
    // fresh one for the real exchange.
    const bad = await t.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: client.redirect_uris[0], client_id: client.client_id, code_verifier: 'x'.repeat(50) });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_grant');
    const again = await t.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: client.redirect_uris[0], client_id: client.client_id, code_verifier: verifier });
    assert.equal(again.status, 400, 'a code is spent on its first use');

    const ok2 = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    const code2 = new URL(ok2.headers.get('location')).searchParams.get('code');
    const tok = await t.form('/oauth/token', { grant_type: 'authorization_code', code: code2, redirect_uri: client.redirect_uris[0], client_id: client.client_id, code_verifier: verifier });
    assert.equal(tok.status, 200);
    assert.equal(tok.headers.get('cache-control'), 'no-store');
    const tokens = await tok.json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, ACCESS_TTL_S);
    assert.equal(tokens.scope, DEFAULT_SCOPE, 'read and write, as asked');
    assert.equal(tokens.scope, 'hub:read hub:write');
    assert.match(tokens.access_token, /^akh_t_/);
    assert.match(tokens.refresh_token, /^akh_r_/);
    assert.ok(!tokens.access_token.includes('.'), 'an opaque token, not a JWT');
    const stored = [...t.store.tokens.values()];
    assert.equal(stored.length, 2);
    assert.ok(stored.every((r) => r.user_id === USER && r.token_hash.length > 20));
    assert.ok(!stored.some((r) => r.token_hash === tokens.access_token));

    // The access token opens /mcp (GET is refused as 405: stateless).
    const mcp = await t.call('/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(mcp.status, 405);

    // Refresh: a new pair; the old refresh token is rotated, and reusing it
    // after the grace window withdraws everything from that sign-in.
    const rf = await t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(rf.status, 200);
    const fresh = await rf.json();
    assert.notEqual(fresh.access_token, tokens.access_token);
    assert.notEqual(fresh.refresh_token, tokens.refresh_token);
    assert.ok(t.store.tokens.get(sha256(tokens.refresh_token)).rotated_at, 'the old refresh token is marked rotated');
    // The new access token is used once, so the minute's cache holds it.
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${fresh.access_token}` } })).status, 405);
    clock.ms += (REFRESH_GRACE_S + 1) * 1000;
    const reuse = await t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(reuse.status, 400);
    assert.equal((await reuse.json()).error, 'invalid_grant');
    assert.ok([...t.store.tokens.values()].every((r) => r.revoked_at || r.rotated_at), 'the whole family is revoked on refresh-token reuse');
    // At once, not a minute later: the cached access token is forgotten.
    const dead = await t.json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${fresh.access_token}` });
    assert.equal(dead.status, 401);
    assert.match(dead.headers.get('www-authenticate'), /error="invalid_token"/);
    assert.equal((await t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: client.client_id })).status, 400, 'the successor refresh token died with the family');

    // A new sign-in, then an explicit revoke.
    const ok3 = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    const code3 = new URL(ok3.headers.get('location')).searchParams.get('code');
    const t3 = await (await t.form('/oauth/token', { grant_type: 'authorization_code', code: code3, redirect_uri: client.redirect_uris[0], client_id: client.client_id, code_verifier: verifier })).json();
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${t3.access_token}` } })).status, 405);
    const rv = await t.form('/oauth/revoke', { token: t3.refresh_token, client_id: client.client_id });
    assert.equal(rv.status, 200);
    const after = await t.call('/mcp', { headers: { Authorization: `Bearer ${t3.access_token}` } });
    assert.equal(after.status, 401, 'revoking the refresh token also ends the access token, at once');
    assert.equal((await t.form('/oauth/revoke', { token: 'akh_r_nothing', client_id: client.client_id })).status, 200, 'an unknown token revokes silently');
  } finally { await t.close(); }
});

test('an expired access token is refused, and an expired code', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const t = await start({ clock });
  try {
    const client = await register(t);
    const { verifier, challenge } = pkce();
    const ok = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    const code = new URL(ok.headers.get('location')).searchParams.get('code');
    clock.ms += (CODE_TTL_S + 1) * 1000;
    const late = await t.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: client.redirect_uris[0], client_id: client.client_id, code_verifier: verifier });
    assert.equal(late.status, 400);
    assert.match((await late.json()).error_description, /expired/);

    const ok2 = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    const code2 = new URL(ok2.headers.get('location')).searchParams.get('code');
    const tokens = await (await t.form('/oauth/token', { grant_type: 'authorization_code', code: code2, redirect_uri: client.redirect_uris[0], client_id: client.client_id, code_verifier: verifier })).json();
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405);
    clock.ms += (ACCESS_TTL_S + 1) * 1000;
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
    // The refresh token still works, and brings a live access token.
    const rf = await (await t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).json();
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${rf.access_token}` } })).status, 405);
  } finally { await t.close(); }
});

test('a wrong password is said plainly, and five of them wait a quarter of an hour', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const t = await start({ clock });
  try {
    const client = await register(t);
    const { challenge } = pkce();
    for (let i = 0; i < SIGN_IN_LIMIT.max; i++) {
      const r = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'wrong' }));
      assert.equal(r.status, 200);
      const body = await r.text();
      assert.match(body, /That email or password is wrong\./);
      assert.match(body, /name="code_challenge"/, 'the form comes back with its parameters');
      assert.doesNotMatch(body, /wrong"/, 'the password is never echoed');
    }
    const limited = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    assert.equal(limited.status, 429);
    assert.match(await limited.text(), /Too many sign-in attempts/);
    // Another lawyer from another address is not held up.
    const other = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'totp@akla.com.pk', password: 'right', totp: '123456' }), { 'X-Forwarded-For': '203.0.113.9' });
    assert.equal(other.status, 302);
    clock.ms += SIGN_IN_LIMIT.windowMs + 1000;
    const later = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    assert.equal(later.status, 302, 'the window has passed');
  } finally { await t.close(); }
});

test('an outsider posting wrong passwords for a lawyer\'s email cannot lock the lawyer out', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const lines = [];
  const t = await start({ clock, log: (l) => lines.push(l) });
  try {
    const client = await register(t);
    const { challenge } = pkce();
    // Five wrong passwords for the partner's email from an outsider's address.
    for (let i = 0; i < SIGN_IN_LIMIT.max; i++) {
      const r = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'guess' }), { 'X-Forwarded-For': '198.51.100.7' });
      assert.equal(r.status, 200);
    }
    const outsider = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'guess' }), { 'X-Forwarded-For': '198.51.100.7' });
    assert.equal(outsider.status, 429, 'the outsider\'s address is held');
    // The lawyer, from their own browser, signs in at once.
    const lawyer = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }), { 'X-Forwarded-For': '203.0.113.20' });
    assert.equal(lawyer.status, 302);
    // Every refusal is logged with the email, so an admin can see the attempt.
    assert.ok(lines.some((l) => /sign-in refused \(bad_password\) for lawyer@akla\.com\.pk from 198\.51\.100\.7/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /rate-limited for lawyer@akla\.com\.pk from 198\.51\.100\.7/.test(l)));
  } finally { await t.close(); }
});

test('a retried or concurrent refresh inside the grace window keeps the sign-in alive', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  // A store with latency, so two refreshes can interleave between the read
  // and the rotation, as they would against Supabase.
  const inner = createMemoryStore();
  const slow = (fn) => async (...a) => { await new Promise((r) => setTimeout(r, 30)); return fn(...a); };
  const store = { ...inner, getToken: slow(inner.getToken), insertTokens: slow(inner.insertTokens), rotateToken: slow(inner.rotateToken) };
  const t = await start({ clock, store });
  try {
    const client = await register(t);
    const { verifier, challenge } = pkce();
    const ok = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    const code = new URL(ok.headers.get('location')).searchParams.get('code');
    const tokens = await (await t.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: client.redirect_uris[0], client_id: client.client_id, code_verifier: verifier })).json();
    const liveRows = () => [...inner.tokens.values()].filter((r) => !r.revoked_at && !r.rotated_at);
    const familyId = liveRows()[0].family_id;

    // (a) The response to a refresh is lost; claude.ai sends the same
    // refresh token again 20 seconds later.
    const first = await (await t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).json();
    clock.ms += 20 * 1000;
    const retry = await t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(retry.status, 200, 'a retry inside the grace window is not a leak');
    const retried = await retry.json();
    assert.notEqual(retried.refresh_token, first.refresh_token);
    assert.ok(liveRows().every((r) => r.family_id === familyId), 'the same family');
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${first.access_token}` } })).status, 405, 'the first pair still works');
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${retried.access_token}` } })).status, 405);

    // (b) Two conversations hit the hour together: both refreshes carry the
    // same token and interleave. Both get a pair; nothing is revoked.
    const [ra, rb] = await Promise.all([
      t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: retried.refresh_token, client_id: client.client_id }),
      t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: retried.refresh_token, client_id: client.client_id }),
    ]);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    const [pa, pb] = await Promise.all([ra.json(), rb.json()]);
    assert.notEqual(pa.refresh_token, pb.refresh_token);
    assert.equal([...inner.tokens.values()].filter((r) => r.revoked_at).length, 0, 'no family revocation');
    assert.equal([...inner.tokens.values()].filter((r) => r.kind === 'refresh' && r.rotated_at).length, 2, 'exactly the two presented refresh tokens are rotated');

    // (c) Past the window, the same old token is a leak: everything dies.
    clock.ms += (REFRESH_GRACE_S + 1) * 1000;
    const late = await t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: retried.refresh_token, client_id: client.client_id });
    assert.equal(late.status, 400);
    assert.equal(liveRows().length, 0);
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${pa.access_token}` } })).status, 401, 'cached access tokens of the family die at once');
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${pb.access_token}` } })).status, 401);
  } finally { await t.close(); }
});

test('a body that says it is JSON and is not gets a 400, not a server error', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const lines = [];
  const t = await start({ clock, log: (l) => lines.push(l) });
  try {
    const raw = (path) => t.call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    const reg = await raw('/oauth/register');
    assert.equal(reg.status, 400);
    assert.deepEqual(await reg.json(), { error: 'invalid_client_metadata', error_description: 'The request body is not valid JSON.' });
    const tok = await raw('/oauth/token');
    assert.equal(tok.status, 400);
    assert.equal((await tok.json()).error, 'invalid_request');
    const rev = await raw('/oauth/revoke');
    assert.equal(rev.status, 400);
    assert.ok(!lines.some((l) => /connector error|SyntaxError/.test(l)), 'no stack trace in the journal');
  } finally { await t.close(); }
});

test('an account awaiting approval cannot connect, and a member removed later loses /mcp', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const members = new Set([USER]);
  const t = await start({ clock, members });
  try {
    const client = await register(t);
    const { verifier, challenge } = pkce();
    const refused = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'new@akla.com.pk', password: 'right' }));
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /not an approved member/);
    assert.equal(t.store.codes.size, 0, 'no code was issued');

    const ok = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    const code = new URL(ok.headers.get('location')).searchParams.get('code');
    const tokens = await (await t.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: client.redirect_uris[0], client_id: client.client_id, code_verifier: verifier })).json();
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405);
    members.delete(USER);
    // The very next request, no cache to wait out: membership is asked each time.
    const gone = await t.call('/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(gone.status, 403);
    // Nor can claude.ai keep minting tokens for them: the refresh grant asks
    // too, refuses, and ends the family.
    const rf = await t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(rf.status, 400);
    assert.equal((await rf.json()).error, 'invalid_grant');
    assert.ok([...t.store.tokens.values()].every((r) => r.revoked_at), 'the family is revoked');
    members.add(USER);
    assert.equal((await t.call('/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401, 'approved again: they sign in afresh');
  } finally { await t.close(); }
});

test('an authenticator code is asked for when the account has one', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const t = await start({ clock });
  try {
    const client = await register(t);
    const { challenge } = pkce();
    const ask = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'totp@akla.com.pk', password: 'right' }));
    assert.equal(ask.status, 200);
    assert.match(await ask.text(), /Enter the 6-digit code from your authenticator app/);
    const wrong = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'totp@akla.com.pk', password: 'right', totp: '000000' }));
    assert.match(await wrong.text(), /authenticator code is wrong/);
    const ok = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'totp@akla.com.pk', password: 'right', totp: '123456' }));
    assert.equal(ok.status, 302);
  } finally { await t.close(); }
});

test('the authorize request is checked: unknown client, foreign redirect, missing PKCE', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const t = await start({ clock });
  try {
    const client = await register(t);
    const { challenge } = pkce();
    const unknown = await t.call(authorizeUrl({ client_id: 'akh_c_nobody', redirect_uris: client.redirect_uris }, { challenge }));
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /not come from a registered client/);
    const foreign = await t.call(authorizeUrl({ ...client, redirect_uris: ['https://evil.example/cb'] }, { challenge }));
    assert.equal(foreign.status, 400, 'never redirect to an address the client did not register');
    const noPkce = await t.call(authorizeUrl(client, { challenge: '' }));
    assert.equal(noPkce.status, 302, 'a bad request from a known client goes back to it as an error');
    const back = new URL(noPkce.headers.get('location'));
    assert.equal(back.searchParams.get('error'), 'invalid_request');
    assert.equal(back.searchParams.get('state'), 'xyz');
    const plain = await t.call(authorizeUrl(client, { challenge, code_challenge_method: 'plain' }));
    assert.equal(new URL(plain.headers.get('location')).searchParams.get('error'), 'invalid_request');
    // A scope the connector does not know is dropped, not refused; the known
    // ones asked for are granted, and none asked for means both.
    const wide = await t.call(authorizeUrl(client, { challenge, scope: 'hub:read offline_access claudeai' }));
    assert.equal(wide.status, 200, 'the sign-in page opens');
    assert.match(await wide.text(), /Read-only: the app can search and read/, 'a sign-in asking for hub:read only is told it is read-only');
    const { verifier: v2 } = pkce();
    const signed = await t.form('/oauth/authorize', formFields(client, challenge, { scope: 'offline_access', email: 'lawyer@akla.com.pk', password: 'right' }));
    assert.equal(signed.status, 302);
    const narrowed = await (await t.form('/oauth/token', { grant_type: 'authorization_code', code: new URL(signed.headers.get('location')).searchParams.get('code'), redirect_uri: client.redirect_uris[0], client_id: client.client_id, code_verifier: v2 })).json();
    assert.equal(narrowed.error, 'invalid_grant', 'the verifier here is deliberately the wrong one; the point is that a code was issued');
    assert.equal([...t.store.codes.values()].at(-1).scope, DEFAULT_SCOPE, 'nothing known asked for: the code carries both');
    const readOnly = await t.form('/oauth/authorize', formFields(client, challenge, { scope: 'claudeai hub:read', email: 'lawyer@akla.com.pk', password: 'right' }));
    assert.equal(readOnly.status, 302);
    assert.equal([...t.store.codes.values()].at(-1).scope, READ_SCOPE, 'hub:read asked for: hub:read only');
    assert.deepEqual(scopeOf('hub:write hub:read x'), { scope: 'hub:read hub:write', ignored: ['x'] }, 'granted in the connector\'s order');
    assert.deepEqual(scopeOf(undefined), { scope: DEFAULT_SCOPE, ignored: [] });
    // Tampering with the hidden fields on the way back is caught too.
    const tampered = await t.form('/oauth/authorize', formFields(client, challenge, { redirect_uri: 'https://evil.example/cb', email: 'lawyer@akla.com.pk', password: 'right' }));
    assert.equal(tampered.status, 400);
  } finally { await t.close(); }
});

test('a confidential client must present its secret; registration is checked', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const t = await start({ clock });
  try {
    const client = await register(t, { token_endpoint_auth_method: 'client_secret_post' });
    assert.match(client.client_secret, /^akh_s_/);
    assert.equal(t.store.clients.get(client.client_id).client_secret_hash, sha256(client.client_secret));
    const { verifier, challenge } = pkce();
    const ok = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    const code = new URL(ok.headers.get('location')).searchParams.get('code');
    const noSecret = await t.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: client.redirect_uris[0], client_id: client.client_id, code_verifier: verifier });
    assert.equal(noSecret.status, 401);
    assert.equal((await noSecret.json()).error, 'invalid_client');
    // Basic auth carries the secret too.
    const ok2 = await t.form('/oauth/authorize', formFields(client, challenge, { email: 'lawyer@akla.com.pk', password: 'right' }));
    const code2 = new URL(ok2.headers.get('location')).searchParams.get('code');
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const withSecret = await t.form('/oauth/token', { grant_type: 'authorization_code', code: code2, redirect_uri: client.redirect_uris[0], code_verifier: verifier }, { Authorization: `Basic ${basic}` });
    assert.equal(withSecret.status, 200);

    const badUri = await t.json('/oauth/register', { redirect_uris: ['http://evil.example/cb'] });
    assert.equal(badUri.status, 400);
    assert.equal((await badUri.json()).error, 'invalid_redirect_uri');
    const none = await t.json('/oauth/register', { client_name: 'x' });
    assert.equal(none.status, 400);
    const local = await t.json('/oauth/register', { redirect_uris: ['http://localhost:3000/cb'] });
    assert.equal(local.status, 400, 'loopback redirects need CONNECTOR_ALLOW_LOOPBACK');
    assert.equal((await t.form('/oauth/token', { grant_type: 'password', client_id: client.client_id })).status, 401, 'the secret comes first; then the grant');
  } finally { await t.close(); }
});

test('a client may only be sent back to claude.ai: a foreign https host cannot register', async () => {
  const clock = { ms: Date.parse('2026-10-19T10:00:00Z') };
  const t = await start({ clock });
  try {
    // The phishing shape: a real-looking name, an outsider's callback.
    const phish = await t.json('/oauth/register', { client_name: 'Claude', redirect_uris: ['https://akla-hub-login.example/cb'] });
    assert.equal(phish.status, 400);
    const body = await phish.json();
    assert.equal(body.error, 'invalid_redirect_uri');
    assert.match(body.error_description, /claude\.ai, claude\.com/);
    assert.equal(t.store.clients.size, 0);
    // One bad URI among good ones refuses the whole registration.
    const mixed = await t.json('/oauth/register', { redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.ai.evil.example/cb'] });
    assert.equal(mixed.status, 400, 'a lookalike host is not a subdomain');
    // claude.com and subdomains of the allowed hosts are fine.
    const fine = await t.json('/oauth/register', { redirect_uris: ['https://claude.com/api/mcp/auth_callback', 'https://app.claude.ai/cb'] });
    assert.equal(fine.status, 201);
    assert.equal(hostAllowed('claude.ai', ['claude.ai']), true);
    assert.equal(hostAllowed('x.claude.ai', ['claude.ai']), true);
    assert.equal(hostAllowed('claude.ai.evil.example', ['claude.ai']), false);
    assert.equal(hostAllowed('notclaude.ai', ['claude.ai']), false);
    assert.equal(validRedirectUri('https://claude.ai/cb#frag'), false);
  } finally { await t.close(); }
  // A dev box may allow loopback, and an admin may name other hosts.
  const dev = await start({ clock, allowLoopback: true, redirectHosts: ['claude.ai', 'hub.example'] });
  try {
    assert.equal((await dev.json('/oauth/register', { redirect_uris: ['http://localhost:3000/cb'] })).status, 201);
    assert.equal((await dev.json('/oauth/register', { redirect_uris: ['http://127.0.0.1:3000/cb'] })).status, 201);
    assert.equal((await dev.json('/oauth/register', { redirect_uris: ['http://evil.example/cb'] })).status, 400, 'plain http elsewhere is never allowed');
    const custom = await dev.json('/oauth/register', { client_name: 'Test', redirect_uris: ['https://hub.example/cb'] });
    assert.equal(custom.status, 201);
    const { challenge } = pkce();
    const page = await (await dev.call(authorizeUrl(await custom.json(), { challenge }))).text();
    assert.match(page, /sent back to <strong>hub\.example<\/strong>/);
  } finally { await dev.close(); }
});

test('pkceMatches is strict about the verifier', () => {
  const { verifier, challenge } = pkce();
  assert.equal(pkceMatches(verifier, challenge), true);
  assert.equal(pkceMatches(`${verifier}x`, challenge), false);
  assert.equal(pkceMatches('short', createHash('sha256').update('short').digest('base64url')), false, 'under 43 characters is not a verifier');
  assert.equal(pkceMatches(undefined, challenge), false);
});
