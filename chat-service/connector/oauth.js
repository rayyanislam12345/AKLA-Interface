// OAuth 2.1 for the claude.ai connector: the connector is its own
// authorization server.
//
// claude.ai adds a custom connector by its MCP URL, reads the two discovery
// documents (RFC 8414 and RFC 9728), registers itself as a client (RFC
// 7591), sends the lawyer to /oauth/authorize with a PKCE challenge, and
// exchanges the code at /oauth/token for the connector's own tokens. Those
// tokens are opaque random strings; only their SHA-256 is stored
// (supabase/migrations/20261019150000_connector_tokens.sql), bound to the
// Supabase user id the sign-in page established. A Supabase JWT never
// reaches claude.ai.
//
// Everything here is pure over a `store` (connector/store.js: Supabase, or
// memory for the tests) and a clock, so the whole flow runs without the
// network. The VM runs Node 20: nothing newer is used.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const SCOPE = "hub:read";
export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 30 * 24 * 60 * 60;
export const CODE_TTL_S = 5 * 60;
// A rotated refresh token may be presented again for this long (a lost
// response, two conversations refreshing together) and gets a fresh pair in
// the same family; presented later, it counts as a leak and the family dies.
export const REFRESH_GRACE_S = 60;
export const MAX_REDIRECT_URIS = 10;
// Where a registered client may send the lawyer back to after sign-in: the
// claude.ai callback hosts (and their subdomains). Anything else is refused
// at registration, so the firm's own sign-in page cannot be pointed at an
// outsider's address. CONNECTOR_REDIRECT_HOSTS overrides this.
export const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com"];

export const sha256 = (s) => createHash("sha256").update(String(s)).digest("base64url");
const random = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** An error the token endpoint answers with as JSON, or the authorize page shows. */
export class OAuthError extends Error {
  constructor(code, description, { status = 400, redirectable = false } = {}) {
    super(description);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
    // The authorize endpoint sends errors back to the client's redirect URI
    // only once the client and the redirect URI have been checked.
    this.redirectable = redirectable;
  }
  toJSON() { return { error: this.code, error_description: this.message }; }
}

const same = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** S256: base64url(sha256(verifier)) must equal the challenge. */
export function pkceMatches(verifier, challenge) {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  return same(sha256(verifier), challenge);
}

// ---------------------------------------------------------------------------
// Discovery

/** The two discovery documents, for an issuer such as https://aklachat.duckdns.org. */
export function metadata(issuer) {
  const base = String(issuer).replace(/\/+$/, "");
  return {
    authorizationServer: {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [SCOPE],
      service_documentation: `${base}/oauth/about`,
    },
    protectedResource: {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
      resource_name: "AKLA Hub",
    },
  };
}

// ---------------------------------------------------------------------------
// Clients

const AUTH_METHODS = new Set(["none", "client_secret_post", "client_secret_basic"]);

/** "a.b.claude.ai" is under "claude.ai"; "claude.ai.evil.example" is not. */
export const hostAllowed = (hostname, hosts) => {
  const h = String(hostname ?? "").toLowerCase();
  return (hosts ?? []).some((allowed) => {
    const a = String(allowed ?? "").trim().toLowerCase();
    return a && (h === a || h.endsWith(`.${a}`));
  });
};

/** The host part of a redirect URI, for the sign-in page ("claude.ai"). */
export function redirectHostOf(uri) {
  try { return new URL(uri).hostname; } catch { return ""; }
}

export function validRedirectUri(uri, { redirectHosts = DEFAULT_REDIRECT_HOSTS, allowLoopback = false } = {}) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === "https:") return hostAllowed(u.hostname, redirectHosts);
  // Loopback redirects (RFC 8252) only when a dev box says so.
  return allowLoopback && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
}

/**
 * Dynamic client registration (RFC 7591). Returns the registration response.
 * A client that says it authenticates with a secret gets one; the default is
 * a public client (claude.ai), which PKCE protects. Redirect URIs must be on
 * an allowed host (see DEFAULT_REDIRECT_HOSTS).
 */
export async function registerClient(store, body, { now = () => new Date(), redirectHosts = DEFAULT_REDIRECT_HOSTS, allowLoopback = false } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u) => typeof u === "string") : [];
  if (!uris.length) throw new OAuthError("invalid_redirect_uri", "redirect_uris is required: at least one https URL.");
  if (uris.length > MAX_REDIRECT_URIS) throw new OAuthError("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect URIs.`);
  const hostList = redirectHosts.join(", ");
  for (const u of uris) if (!validRedirectUri(u, { redirectHosts, allowLoopback })) throw new OAuthError("invalid_redirect_uri", `Redirect URIs must be https on ${hostList}${allowLoopback ? " (or http://localhost)" : ""}: ${u}`);
  const method = typeof b.token_endpoint_auth_method === "string" ? b.token_endpoint_auth_method : "none";
  if (!AUTH_METHODS.has(method)) throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method must be one of none, client_secret_post, client_secret_basic.`);
  const grants = Array.isArray(b.grant_types) && b.grant_types.length ? b.grant_types.map(String) : ["authorization_code", "refresh_token"];
  for (const g of grants) if (g !== "authorization_code" && g !== "refresh_token") throw new OAuthError("invalid_client_metadata", `Unsupported grant type: ${g}`);
  const responseTypes = Array.isArray(b.response_types) && b.response_types.length ? b.response_types.map(String) : ["code"];
  for (const r of responseTypes) if (r !== "code") throw new OAuthError("invalid_client_metadata", `Unsupported response type: ${r}`);
  const id = `akh_c_${random(16)}`;
  const secret = method === "none" ? null : `akh_s_${random(32)}`;
  const issuedAt = now();
  const row = {
    id,
    client_name: typeof b.client_name === "string" ? b.client_name.slice(0, 200) : null,
    client_secret_hash: secret ? sha256(secret) : null,
    token_endpoint_auth_method: method,
    redirect_uris: uris,
    grant_types: grants,
    client_uri: typeof b.client_uri === "string" ? b.client_uri.slice(0, 500) : null,
    software_id: typeof b.software_id === "string" ? b.software_id.slice(0, 200) : null,
    created_at: issuedAt.toISOString(),
  };
  await store.insertClient(row);
  return {
    client_id: id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
    client_name: row.client_name ?? undefined,
    redirect_uris: uris,
    grant_types: grants,
    response_types: responseTypes,
    token_endpoint_auth_method: method,
    scope: SCOPE,
  };
}

/** The client a token-endpoint request speaks for, its secret checked when it has one. */
export async function authenticateClient(store, { clientId, clientSecret }) {
  if (!clientId) throw new OAuthError("invalid_client", "client_id is required.", { status: 401 });
  const client = await store.getClient(String(clientId));
  if (!client) throw new OAuthError("invalid_client", "Unknown client. Remove the connector in claude.ai and add it again.", { status: 401 });
  if (client.token_endpoint_auth_method !== "none") {
    if (!clientSecret || !same(sha256(clientSecret), client.client_secret_hash)) throw new OAuthError("invalid_client", "The client secret is wrong.", { status: 401 });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Authorization

/**
 * Checks an authorization request. Throws an OAuthError the page should
 * show (unknown client, bad redirect URI: never redirect to those) or one to
 * send back to the client's redirect URI (`redirectable`). Returns what the
 * sign-in form must carry through.
 */
export async function checkAuthorizeRequest(store, params, { issuer } = {}) {
  const p = params ?? {};
  const clientId = typeof p.client_id === "string" ? p.client_id : "";
  const client = clientId ? await store.getClient(clientId) : null;
  if (!client) throw new OAuthError("invalid_client", "This sign-in link does not come from a registered client. Remove the connector in claude.ai and add it again.");
  const redirectUri = typeof p.redirect_uri === "string" ? p.redirect_uri : "";
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) throw new OAuthError("invalid_request", "The redirect address in this sign-in link is not one the client registered.");
  const state = typeof p.state === "string" ? p.state.slice(0, 2000) : "";
  if (p.response_type !== "code") throw new OAuthError("unsupported_response_type", "response_type must be code.", { redirectable: true });
  const challenge = typeof p.code_challenge === "string" ? p.code_challenge : "";
  if (!challenge) throw new OAuthError("invalid_request", "code_challenge is required (PKCE).", { redirectable: true });
  if ((p.code_challenge_method ?? "S256") !== "S256") throw new OAuthError("invalid_request", "code_challenge_method must be S256.", { redirectable: true });
  if (!/^[A-Za-z0-9\-_]{43}$/.test(challenge)) throw new OAuthError("invalid_request", "code_challenge must be base64url(SHA-256(verifier)).", { redirectable: true });
  const { scope, ignored: ignoredScopes } = scopeOf(p.scope);
  const resource = typeof p.resource === "string" && p.resource ? p.resource : null;
  if (resource && issuer && !resource.startsWith(String(issuer).replace(/\/+$/, ""))) throw new OAuthError("invalid_target", "The resource asked for is not this connector.", { redirectable: true });
  return { client, redirectUri, state, codeChallenge: challenge, scope, resource, ignoredScopes, redirectHost: redirectHostOf(redirectUri) };
}

// Only hub:read exists, so that is what every sign-in grants. A client that
// asks for more (offline_access, a scope of its own) is not turned away:
// RFC 6749 §3.3 lets the server narrow the scope, and the token response
// says what was granted. What was dropped is returned for the log.
export function scopeOf(raw) {
  const asked = typeof raw === "string" ? raw.split(/\s+/).filter(Boolean) : [];
  return { scope: SCOPE, ignored: asked.filter((s) => s !== SCOPE) };
}

/** After a successful sign-in: the code to send back to the client. */
export async function issueCode(store, { client, userId, redirectUri, codeChallenge, scope = SCOPE, resource = null }, { now = () => new Date() } = {}) {
  const code = `akh_a_${random(32)}`;
  const at = now();
  await store.insertCode({
    code_hash: sha256(code),
    client_id: client.id,
    user_id: userId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope,
    resource,
    created_at: at.toISOString(),
    expires_at: new Date(at.getTime() + CODE_TTL_S * 1000).toISOString(),
  });
  return code;
}

/** The redirect that carries a code (or an error) back to the client. */
export function redirectWith(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}

// ---------------------------------------------------------------------------
// Tokens

async function mintPair(store, { client, userId, scope, familyId }, now) {
  const at = now();
  const access = `akh_t_${random(32)}`;
  const refresh = `akh_r_${random(32)}`;
  const rows = [
    { id: randomUUID(), kind: "access", token_hash: sha256(access), client_id: client.id, user_id: userId, family_id: familyId, scope, created_at: at.toISOString(), expires_at: new Date(at.getTime() + ACCESS_TTL_S * 1000).toISOString() },
    { id: randomUUID(), kind: "refresh", token_hash: sha256(refresh), client_id: client.id, user_id: userId, family_id: familyId, scope, created_at: at.toISOString(), expires_at: new Date(at.getTime() + REFRESH_TTL_S * 1000).toISOString() },
  ];
  await store.insertTokens(rows);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
}

const live = (row, at) => row && !row.revoked_at && !row.rotated_at && new Date(row.expires_at).getTime() > at.getTime();

/**
 * The token endpoint: authorization_code (with PKCE) or refresh_token.
 *
 * A refresh token is rotated in one conditional update (store.rotateToken),
 * so two requests carrying the same token cannot both win it. The loser,
 * and a client retrying a refresh whose response was lost, still gets a
 * pair in the same family if the token was rotated within REFRESH_GRACE_S;
 * after that, presenting a rotated token means it leaked and the whole
 * family is revoked (OAuth 2.1 §4.3.1).
 *
 * `isMember(userId)` is asked on every refresh: a lawyer whose approval was
 * withdrawn gets invalid_grant and their family is revoked, so claude.ai
 * cannot keep minting tokens for them. `onFamilyRevoked(familyId)` lets the
 * app drop its bearer cache the moment a family dies.
 */
export async function exchangeToken(store, params, { now = () => new Date(), clientAuth = {}, isMember = null, onFamilyRevoked = () => {}, log = () => {} } = {}) {
  const p = params ?? {};
  const clientId = clientAuth.clientId ?? p.client_id;
  const clientSecret = clientAuth.clientSecret ?? p.client_secret;
  const client = await authenticateClient(store, { clientId, clientSecret });
  const at = now();
  const killFamily = async (familyId) => {
    await store.revokeFamily(familyId, at);
    try { await onFamilyRevoked(familyId); } catch { /* the cache is advisory */ }
  };
  if (p.grant_type === "authorization_code") {
    if (!client.grant_types.includes("authorization_code")) throw new OAuthError("unauthorized_client", "This client may not use the authorization code grant.");
    const code = typeof p.code === "string" ? p.code : "";
    if (!code) throw new OAuthError("invalid_request", "code is required.");
    const row = await store.consumeCode(sha256(code), at);
    if (!row) throw new OAuthError("invalid_grant", "This code was already used, or does not exist. Sign in again.");
    if (row.client_id !== client.id) throw new OAuthError("invalid_grant", "This code belongs to another client.");
    if (new Date(row.expires_at).getTime() <= at.getTime()) throw new OAuthError("invalid_grant", "This code has expired. Sign in again.");
    if (typeof p.redirect_uri === "string" && p.redirect_uri && p.redirect_uri !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match the one the code was issued for.");
    if (!pkceMatches(p.code_verifier, row.code_challenge)) throw new OAuthError("invalid_grant", "The PKCE verifier does not match the challenge.");
    return mintPair(store, { client, userId: row.user_id, scope: row.scope ?? SCOPE, familyId: randomUUID() }, now);
  }
  if (p.grant_type === "refresh_token") {
    if (!client.grant_types.includes("refresh_token")) throw new OAuthError("unauthorized_client", "This client may not refresh tokens.");
    const token = typeof p.refresh_token === "string" ? p.refresh_token : "";
    if (!token) throw new OAuthError("invalid_request", "refresh_token is required.");
    const hash = sha256(token);
    const row = await store.getToken(hash);
    if (!row || row.kind !== "refresh" || row.client_id !== client.id) throw new OAuthError("invalid_grant", "Unknown refresh token. Sign in again.");
    if (new Date(row.expires_at).getTime() <= at.getTime()) throw new OAuthError("invalid_grant", "This refresh token has expired. Sign in again.");
    if (row.revoked_at) throw new OAuthError("invalid_grant", "This sign-in was withdrawn. Sign in again.");
    // Still an approved firm member? The site asks on every request; so does
    // every refresh, and a withdrawn approval ends the sign-in here.
    if (isMember && (await isMember(row.user_id)) !== true) {
      await killFamily(row.family_id);
      throw new OAuthError("invalid_grant", "Your Hub account is no longer an approved firm member. Ask an administrator.");
    }
    const pair = { client, userId: row.user_id, scope: row.scope ?? SCOPE, familyId: row.family_id };
    const won = await store.rotateToken(hash, at);
    if (won) return mintPair(store, pair, now);
    // Someone rotated it first: a retry or a concurrent refresh inside the
    // grace window, or a leak outside it.
    const current = await store.getToken(hash);
    const rotatedAt = current?.rotated_at ? new Date(current.rotated_at).getTime() : null;
    if (rotatedAt != null && !current.revoked_at && at.getTime() - rotatedAt <= REFRESH_GRACE_S * 1000) {
      log(`refresh token presented again ${Math.round((at.getTime() - rotatedAt) / 1000)}s after rotation (family ${row.family_id}): a fresh pair in the same family`);
      return mintPair(store, pair, now);
    }
    // A refresh token used twice means it leaked: everything from that
    // sign-in is withdrawn (OAuth 2.1 §4.3.1).
    await killFamily(row.family_id);
    throw new OAuthError("invalid_grant", "This refresh token was already used. Sign in again.");
  }
  throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
}

/**
 * The revocation endpoint (RFC 7009). Revoking either token of a family
 * revokes the family. Unknown tokens succeed silently, as the RFC says.
 */
export async function revokeToken(store, params, { now = () => new Date(), clientAuth = {}, onFamilyRevoked = () => {} } = {}) {
  const p = params ?? {};
  const client = await authenticateClient(store, { clientId: clientAuth.clientId ?? p.client_id, clientSecret: clientAuth.clientSecret ?? p.client_secret });
  const token = typeof p.token === "string" ? p.token : "";
  if (!token) return null;
  const row = await store.getToken(sha256(token));
  if (!row || row.client_id !== client.id) return null;
  await store.revokeFamily(row.family_id, now());
  try { await onFamilyRevoked(row.family_id); } catch { /* the cache is advisory */ }
  return row.family_id;
}

/**
 * Who a bearer token speaks for: { userId, clientId, scope, tokenId } or
 * null when it is unknown, expired, revoked, or not an access token.
 */
export async function authenticateBearer(store, token, { now = () => new Date() } = {}) {
  if (typeof token !== "string" || !token.startsWith("akh_t_")) return null;
  const row = await store.getToken(sha256(token));
  if (!row || row.kind !== "access" || !live(row, now())) return null;
  return { userId: row.user_id, clientId: row.client_id, scope: row.scope ?? SCOPE, tokenId: row.id, familyId: row.family_id, expiresAt: row.expires_at };
}

/** "Bearer x" / "Basic base64(id:secret)" from a request's Authorization header. */
export function parseAuthorization(header) {
  const h = String(header ?? "").trim();
  const m = /^(Bearer|Basic)\s+(.+)$/i.exec(h);
  if (!m) return {};
  if (m[1].toLowerCase() === "bearer") return { bearer: m[2].trim() };
  try {
    const decoded = Buffer.from(m[2].trim(), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return {};
    return { clientId: decodeURIComponent(decoded.slice(0, i)), clientSecret: decodeURIComponent(decoded.slice(i + 1)) };
  } catch {
    return {};
  }
}
