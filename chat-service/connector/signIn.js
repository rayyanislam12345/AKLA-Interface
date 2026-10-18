// Signing a lawyer in with their Hub login, on the server.
//
// The sign-in page posts email, password and (when the account has one) the
// authenticator code. This signs in against Supabase Auth with the
// publishable key exactly as the site does (signInWithPassword, then the
// TOTP challenge), reads the user id, checks they are an approved firm
// member (is_firm_member, the rule every table policy uses), and drops the
// Supabase session again (a local sign-out: the lawyer's own Hub sessions
// are untouched). The Supabase session lives for the few hundred
// milliseconds this takes and never leaves this process; the connector then
// issues its own tokens (oauth.js) bound to the user id.
//
// Every outcome is a plain object, never a throw, so the page can say what
// happened in plain English:
//   { ok: true, userId, email }
//   { ok: false, reason: "bad_password" | "needs_totp" | "bad_totp" | "not_member" | "error", message }

import { createClient as supabaseCreateClient } from "@supabase/supabase-js";

const MESSAGES = {
  bad_password: "That email or password is wrong.",
  needs_totp: "Your account uses an authenticator app. Enter the 6-digit code from it.",
  bad_totp: "That authenticator code is wrong or has expired. Try the next one.",
  not_member: "Your Hub account is not an approved member of the firm, so it cannot use the connector. Ask an administrator to approve it.",
  error: "Signing in did not work just now. Try again in a moment.",
};

/**
 * @param {{ supabaseUrl: string, publishableKey: string, serviceClient: object, createClient?: Function, log?: Function }} deps
 * serviceClient: the service-role client, for is_firm_member.
 */
export function createSignIn({ supabaseUrl, publishableKey, serviceClient, createClient = supabaseCreateClient, log = () => {} }) {
  if (!supabaseUrl || !publishableKey) throw new Error("createSignIn needs supabaseUrl and publishableKey");
  const refuse = (reason, detail) => {
    if (detail) log(`sign-in refused (${reason}): ${detail}`);
    return { ok: false, reason, message: MESSAGES[reason] ?? MESSAGES.error };
  };
  return async function signIn({ email, password, totp = "" }) {
    const mail = String(email ?? "").trim().toLowerCase();
    const pass = String(password ?? "");
    const code = String(totp ?? "").replace(/\s+/g, "");
    if (!mail || !pass) return refuse("bad_password");
    // A client of its own per sign-in: nothing persisted, nothing refreshed.
    const auth = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    try {
      const { data, error } = await auth.auth.signInWithPassword({ email: mail, password: pass });
      if (error || !data?.user) return refuse("bad_password", error?.message);
      const userId = data.user.id;

      // Two-factor: the site asks for the code when the account's next
      // assurance level is aal2; so does this.
      const { data: aal, error: aalError } = await auth.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalError) return refuse("error", `assurance level: ${aalError.message}`);
      if (aal?.nextLevel === "aal2" && aal?.currentLevel !== "aal2") {
        if (!/^\d{6}$/.test(code)) return refuse("needs_totp");
        const { data: factors, error: factorsError } = await auth.auth.mfa.listFactors();
        if (factorsError) return refuse("error", `factors: ${factorsError.message}`);
        const factor = (factors?.totp ?? []).find((f) => f.status === "verified") ?? (factors?.totp ?? [])[0];
        if (!factor) return refuse("error", "the account needs a second factor but has no verified authenticator");
        const { error: verifyError } = await auth.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
        if (verifyError) return refuse("bad_totp", verifyError.message);
      }

      const { data: isMember, error: memberError } = await serviceClient.rpc("is_firm_member", { _user_id: userId });
      if (memberError) return refuse("error", `is_firm_member: ${memberError.message}`);
      if (isMember !== true) return refuse("not_member", mail);
      return { ok: true, userId, email: mail };
    } catch (err) {
      return refuse("error", err?.message ?? String(err));
    } finally {
      // The Supabase session is finished with. Local only: this ends the
      // throwaway session this process created and nothing else. A global
      // sign-out would end the lawyer's Hub sessions on every device (the
      // site's "sign out everywhere"), and anyone with a password but no
      // authenticator code could trigger it from this form.
      try { await auth.auth.signOut({ scope: "local" }); } catch { /* nothing to keep */ }
    }
  };
}

export { MESSAGES as SIGN_IN_MESSAGES };
