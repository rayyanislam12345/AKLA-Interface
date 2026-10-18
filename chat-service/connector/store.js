// Where the connector keeps its OAuth records: the three tables of
// supabase/migrations/20261019150000_connector_tokens.sql through the service
// role, or memory for the tests. Both offer the same small interface, which
// oauth.js is written against:
//
//   insertClient(row)              getClient(id)
//   insertCode(row)                consumeCode(codeHash, now) -> row | null (marks it used, once)
//   insertTokens(rows)             getToken(tokenHash)
//   rotateToken(tokenHash, now) -> row | null (marks a refresh token rotated, once)
//   revokeFamily(familyId, now)
//   touchClient(id, now)           touchToken(id, now)
//
// A token row has two end states: rotated_at (a refresh token superseded by
// the pair minted from it; oauth.js allows a short grace window for a retry)
// and revoked_at (withdrawn: by the revocation endpoint, a reuse outside the
// window, a lost membership, or an administrator's SQL). Neither is live.

const fail = (what, error) => new Error(`${what}: ${error?.message ?? "unknown error"}`);

/** The Supabase-backed store. `supabase` must hold the service role. */
export function createSupabaseStore(supabase) {
  return {
    async insertClient(row) {
      const { error } = await supabase.from("connector_clients").insert(row);
      if (error) throw fail("Could not save the client registration", error);
    },
    async getClient(id) {
      const { data, error } = await supabase.from("connector_clients").select("*").eq("id", id).maybeSingle();
      if (error) throw fail("Could not read the client", error);
      return data ?? null;
    },
    async touchClient(id, now) {
      await supabase.from("connector_clients").update({ last_used_at: now.toISOString() }).eq("id", id);
    },
    async insertCode(row) {
      const { error } = await supabase.from("connector_auth_codes").insert(row);
      if (error) throw fail("Could not save the authorization code", error);
    },
    async consumeCode(codeHash, now) {
      // One statement: the row is marked used only if it was not already,
      // so two exchanges of the same code cannot both succeed.
      const { data, error } = await supabase.from("connector_auth_codes").update({ used_at: now.toISOString() }).eq("code_hash", codeHash).is("used_at", null).select("*").maybeSingle();
      if (error) throw fail("Could not use the authorization code", error);
      return data ?? null;
    },
    async insertTokens(rows) {
      const { error } = await supabase.from("connector_tokens").insert(rows);
      if (error) throw fail("Could not save the tokens", error);
    },
    async getToken(tokenHash) {
      const { data, error } = await supabase.from("connector_tokens").select("*").eq("token_hash", tokenHash).maybeSingle();
      if (error) throw fail("Could not read the token", error);
      return data ?? null;
    },
    async rotateToken(tokenHash, now) {
      // One statement, as consumeCode: only the first of two concurrent
      // refreshes gets the row back; the other sees null.
      const { data, error } = await supabase.from("connector_tokens").update({ rotated_at: now.toISOString() }).eq("token_hash", tokenHash).is("rotated_at", null).is("revoked_at", null).select("*").maybeSingle();
      if (error) throw fail("Could not rotate the refresh token", error);
      return data ?? null;
    },
    async revokeFamily(familyId, now) {
      const { error } = await supabase.from("connector_tokens").update({ revoked_at: now.toISOString() }).eq("family_id", familyId).is("revoked_at", null);
      if (error) throw fail("Could not revoke the tokens", error);
    },
    async touchToken(id, now) {
      await supabase.from("connector_tokens").update({ last_used_at: now.toISOString() }).eq("id", id);
    },
  };
}

/** An in-memory store with the same shape (tests, and nothing else). */
export function createMemoryStore() {
  const clients = new Map();
  const codes = new Map();
  const tokens = new Map();
  return {
    clients, codes, tokens,
    async insertClient(row) { clients.set(row.id, { last_used_at: null, ...row }); },
    async getClient(id) { return clients.get(id) ? { ...clients.get(id) } : null; },
    async touchClient(id, now) { const c = clients.get(id); if (c) c.last_used_at = now.toISOString(); },
    async insertCode(row) { codes.set(row.code_hash, { used_at: null, ...row }); },
    async consumeCode(codeHash, now) {
      const row = codes.get(codeHash);
      if (!row || row.used_at) return null;
      row.used_at = now.toISOString();
      return { ...row };
    },
    async insertTokens(rows) { for (const r of rows) tokens.set(r.token_hash, { revoked_at: null, rotated_at: null, last_used_at: null, ...r }); },
    async getToken(tokenHash) { return tokens.get(tokenHash) ? { ...tokens.get(tokenHash) } : null; },
    async rotateToken(tokenHash, now) {
      const t = tokens.get(tokenHash);
      if (!t || t.rotated_at || t.revoked_at) return null;
      t.rotated_at = now.toISOString();
      return { ...t };
    },
    async revokeFamily(familyId, now) { for (const t of tokens.values()) if (t.family_id === familyId && !t.revoked_at) t.revoked_at = now.toISOString(); },
    async touchToken(id, now) { for (const t of tokens.values()) if (t.id === id) t.last_used_at = now.toISOString(); },
  };
}
