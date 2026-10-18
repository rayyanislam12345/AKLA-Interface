// The server-side Hub login behind the connector's sign-in page, against a
// stubbed supabase-js: the throwaway Supabase session is ended with a LOCAL
// sign-out only, on every path (success, no authenticator code, wrong code,
// not a member), so the lawyer's own Hub sessions on their laptop and phone
// are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignIn } from '../connector/signIn.js';

const USER = '11111111-1111-4111-8111-111111111111';

function stubSupabase({ password = 'right', nextLevel = 'aal1', totpOk = '123456', member = true } = {}) {
  const calls = { signOut: [], rpc: [] };
  const createClient = () => ({
    auth: {
      async signInWithPassword({ email, password: p }) {
        if (p !== password) return { data: { user: null }, error: { message: 'Invalid login credentials' } };
        return { data: { user: { id: USER, email } }, error: null };
      },
      mfa: {
        async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel }, error: null }; },
        async listFactors() { return { data: { totp: [{ id: 'f1', status: 'verified' }] }, error: null }; },
        async challengeAndVerify({ code }) { return code === totpOk ? { data: {}, error: null } : { data: null, error: { message: 'Invalid TOTP code' } }; },
      },
      async signOut(opts) { calls.signOut.push(opts); return { error: null }; },
    },
  });
  const serviceClient = { async rpc(name, args) { calls.rpc.push([name, args]); return { data: member, error: null }; } };
  return { calls, createClient, serviceClient };
}

const make = (stub) => createSignIn({ supabaseUrl: 'https://x.supabase.co', publishableKey: 'sb_publishable_x', serviceClient: stub.serviceClient, createClient: stub.createClient });

test('a right password signs in, checks membership, and ends only the local session', async () => {
  const stub = stubSupabase();
  const r = await make(stub)({ email: 'Lawyer@AKLA.com.pk ', password: 'right' });
  assert.deepEqual(r, { ok: true, userId: USER, email: 'lawyer@akla.com.pk' });
  assert.deepEqual(stub.calls.rpc, [['is_firm_member', { _user_id: USER }]]);
  assert.deepEqual(stub.calls.signOut, [{ scope: 'local' }], 'never a global sign-out: that would log the lawyer out of the Hub everywhere');
});

test('every refused path also signs out locally, never globally', async () => {
  // The password is right but the authenticator code is missing, then wrong.
  const stub = stubSupabase({ nextLevel: 'aal2' });
  const signIn = make(stub);
  assert.equal((await signIn({ email: 'a@akla.com.pk', password: 'right' })).reason, 'needs_totp');
  assert.equal((await signIn({ email: 'a@akla.com.pk', password: 'right', totp: '000000' })).reason, 'bad_totp');
  assert.equal((await signIn({ email: 'a@akla.com.pk', password: 'right', totp: '123 456' })).ok, true);
  assert.equal(stub.calls.signOut.length, 3);
  assert.ok(stub.calls.signOut.every((o) => o?.scope === 'local'), JSON.stringify(stub.calls.signOut));
  // Not a member.
  const outsider = stubSupabase({ member: false });
  assert.equal((await make(outsider)({ email: 'b@akla.com.pk', password: 'right' })).reason, 'not_member');
  assert.deepEqual(outsider.calls.signOut, [{ scope: 'local' }]);
  // A wrong password never reaches a session, so there is nothing to sign out.
  const wrong = stubSupabase();
  assert.equal((await make(wrong)({ email: 'c@akla.com.pk', password: 'nope' })).reason, 'bad_password');
  assert.deepEqual(wrong.calls.signOut, [{ scope: 'local' }], 'the client is dropped either way');
  assert.deepEqual(wrong.calls.rpc, [], 'membership is not asked for a wrong password');
});
