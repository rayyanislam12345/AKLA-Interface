// The connector's HTTP surface, as one request handler over plain node:http
// (no framework; the same shape as server.js). connector.js wires it to the
// real services; the tests wire it to stubs and drive it with the MCP SDK's
// own client.
//
//   GET  /health                                   who is running
//   GET  /.well-known/oauth-authorization-server   RFC 8414 (also with /mcp appended)
//   GET  /.well-known/oauth-protected-resource     RFC 9728 (also with /mcp appended)
//   POST /oauth/register                           dynamic client registration
//   GET  /oauth/authorize                          the sign-in form
//   POST /oauth/authorize                          the sign-in itself -> code
//   POST /oauth/token                              code or refresh -> tokens
//   POST /oauth/revoke                             withdraw a token's family
//   GET  /oauth/about                              what this is
//   POST /mcp                                      the MCP endpoint (bearer token)
//   GET/DELETE /mcp                                405: stateless, one server per request
//
// Only Caddy reaches this process (it binds to 127.0.0.1), so the client's
// address is X-Forwarded-For. The VM runs Node 20: nothing newer is used.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DEFAULT_REDIRECT_HOSTS, DEFAULT_SCOPE, OAuthError, READ_ONLY_REFUSAL, WRITE_SCOPE, authenticateBearer, checkAuthorizeRequest, exchangeToken, hasScope, issueCode, metadata, parseAuthorization, redirectWith, registerClient, revokeToken, sha256 } from "./oauth.js";
import { aboutPage, errorPage, signInPage } from "./pages.js";

export const MAX_BODY_BYTES = 1_000_000;
// POST /mcp alone takes more: a fill_standard_to_project call may carry 300
// changes each quoting a paragraph and its new text at up to 20,000
// characters (connector/tools/fillStandardWrite.js), about 12 MB of JSON at
// the very most. Only a signed-in bearer reaches this read.
export const MAX_MCP_BODY_BYTES = 12_500_000;
// How a tool is marked for claude.ai. A tool without annotations of its own
// is read-only. A write tool (one with `write: true`, registered only when
// the token carries hub:write) ships as not read-only AND destructive, so
// claude.ai asks "Allow once / Always allow" before every one of them:
// "destructive always prompts" is the only documented rule, and whether a
// merely not-read-only tool prompts is checked live on the first save
// (plan, Try later 6). Research mode calls tools without asking whatever
// the annotation says; the sign-in page tells the lawyer to set the write
// tools to "Needs approval" under the connector's Tool permissions.
export const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
export const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
// Sign-in: failures per (email, address) pair and per address in a window.
// A right password never counts; a lawyer who mistypes five times waits a
// quarter of an hour. Keying the email counter on the address too means an
// outsider posting wrong passwords for a partner's email locks out only
// their own address, never the partner's browser; Supabase Auth's own
// per-account limit stands behind both.
export const SIGN_IN_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
export const SIGN_IN_IP_LIMIT = { max: 20, windowMs: 15 * 60 * 1000 };
export const REGISTER_LIMIT = { max: 30, windowMs: 60 * 60 * 1000 };
export const TOKEN_FAIL_LIMIT = { max: 60, windowMs: 15 * 60 * 1000 };
// A bearer token is looked up once a minute at most. Firm membership is
// asked on every /mcp request and every refresh (one cheap RPC, the same
// cost the site pays), so a withdrawn approval bites at once.
const BEARER_CACHE_MS = 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version, www-authenticate",
  "Access-Control-Max-Age": "86400",
};

/** Counts events per key inside a sliding window: { check(key) -> seconds to wait or 0, hit(key) }. */
export function createRateLimiter({ max, windowMs }, now = () => Date.now()) {
  const hits = new Map();
  const prune = (key, t) => {
    const list = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  return {
    check(key) {
      const list = prune(key, now());
      if (list.length < max) return 0;
      return Math.max(1, Math.ceil((windowMs - (now() - list[0])) / 1000));
    },
    hit(key) {
      const t = now();
      const list = prune(key, t);
      list.push(t);
      hits.set(key, list);
      // Keys nobody has touched in a window are forgotten.
      if (hits.size > 10_000) for (const k of hits.keys()) { if (!prune(k, t).length) hits.delete(k); }
    },
  };
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("The request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * JSON or a form, by content type; {} when empty. A body that says it is
 * JSON and is not throws an OAuthError (400 with `jsonError` as its code),
 * never a SyntaxError for the server to mistake for its own fault.
 */
function parseBody(raw, contentType, { jsonError = "invalid_request" } = {}) {
  if (!raw) return {};
  const type = String(contentType ?? "").toLowerCase();
  if (type.includes("application/json")) {
    let v;
    try { v = JSON.parse(raw); } catch { throw new OAuthError(jsonError, "The request body is not valid JSON."); }
    return v && typeof v === "object" ? v : {};
  }
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  // No type: try JSON, then a form.
  try { const v = JSON.parse(raw); if (v && typeof v === "object") return v; } catch { /* a form, then */ }
  return Object.fromEntries(new URLSearchParams(raw));
}

const AUTHORIZE_FIELDS = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"];
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, typeof obj?.[k] === "string" ? obj[k] : undefined]).filter(([, v]) => v !== undefined));

/**
 * @param {object} deps
 * @param {object} deps.store        connector/store.js
 * @param {Function} deps.signIn     connector/signIn.js
 * @param {Array} deps.tools         connector/tools.js
 * @param {Function} deps.isMember   (userId) -> Promise<boolean>; asked on every /mcp request and refresh
 * @param {string} deps.issuer       https://aklachat.duckdns.org
 * @param {string[]} [deps.redirectHosts]  hosts a client may register redirect URIs on (claude.ai, claude.com)
 * @param {boolean} [deps.allowLoopback]   also http://localhost redirects (a dev box only)
 * @param {object} [deps.version]    { commit, deployedAt } for /health
 * @param {Function} [deps.now]      () -> Date
 * @param {Function} [deps.log]
 */
export function createApp({ store, signIn, tools, isMember, issuer, redirectHosts = DEFAULT_REDIRECT_HOSTS, allowLoopback = false, version = {}, now = () => new Date(), log = console.log, serverVersion = "1.0.0" }) {
  const base = String(issuer).replace(/\/+$/, "");
  const docs = metadata(base);
  const nowMs = () => now().getTime();
  const signInByEmail = createRateLimiter(SIGN_IN_LIMIT, nowMs);
  const signInByIp = createRateLimiter(SIGN_IN_IP_LIMIT, nowMs);
  const registerByIp = createRateLimiter(REGISTER_LIMIT, nowMs);
  const tokenFailByIp = createRateLimiter(TOKEN_FAIL_LIMIT, nowMs);
  const bearerCache = new Map();
  let inFlight = 0;
  // The minute's bearer cache must not outlive a family: the revocation
  // endpoint, a refresh-token reuse and a lost membership all call this.
  const forgetFamily = (familyId) => { for (const [k, v] of bearerCache) if (v.auth.familyId === familyId) bearerCache.delete(k); };

  const ipOf = (req) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";

  const send = (res, status, body, headers = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, { ...CORS, ...headers });
    res.end(body);
  };
  const json = (res, status, body, headers = {}) => send(res, status, JSON.stringify(body), { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...headers });
  const html = (res, status, body) => send(res, status, body, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
  const oauthFail = (res, err) => {
    if (err instanceof OAuthError) return json(res, err.status, err.toJSON());
    if (err?.status === 413) return json(res, 413, { error: "invalid_request", error_description: err.message });
    log(`connector error: ${err?.stack ?? err}`);
    return json(res, 500, { error: "server_error", error_description: "The connector hit a problem. Try again in a moment." });
  };

  async function bearerOf(req) {
    const { bearer } = parseAuthorization(req.headers.authorization);
    if (!bearer) return null;
    const key = sha256(bearer);
    const hit = bearerCache.get(key);
    if (hit && nowMs() - hit.at < BEARER_CACHE_MS && new Date(hit.auth.expiresAt).getTime() > nowMs()) return hit.auth;
    const auth = await authenticateBearer(store, bearer, { now });
    if (!auth) { bearerCache.delete(key); return null; }
    bearerCache.set(key, { at: nowMs(), auth });
    if (bearerCache.size > 5000) bearerCache.delete(bearerCache.keys().next().value);
    return auth;
  }

  // Every request: the site applies is_firm_member on every query, and a
  // withdrawn approval must stop the connector just as quickly.
  const stillMember = async (userId) => (await isMember(userId)) === true;

  // A write re-checks the sign-in afresh (the token row, by its hash: gone,
  // revoked or expired means null), never the minute's cache; membership
  // was asked at the top of this same request. The token's last use is
  // noted. Null drops the cache entry too.
  async function recheckBearer(bearer) {
    const fresh = await authenticateBearer(store, bearer, { now });
    if (!fresh) { bearerCache.delete(sha256(bearer)); return null; }
    store.touchToken(fresh.tokenId, now()).catch(() => {});
    return fresh;
  }

  const challenge = (res, error, description, status = 401) => {
    // RFC 9728 §3: the well-known path is inserted between the host and the
    // resource's path, so a resource at /mcp has its document at
    // /.well-known/oauth-protected-resource/mcp (the root document is also
    // served, for clients that look there first).
    // The scope named here is what claude.ai asks for at sign-in (its docs:
    // the challenge's scope wins, else everything in scopes_supported).
    const parts = [`Bearer realm="AKLA Hub"`, `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, `scope="${DEFAULT_SCOPE}"`];
    if (error) parts.push(`error="${error}"`, `error_description="${description.replace(/"/g, "'")}"`);
    return json(res, status, { error: error ?? "unauthorized", error_description: description }, { "WWW-Authenticate": parts.join(", ") });
  };

  // One MCP server per request (stateless Streamable HTTP): claude.ai keeps
  // no session with us, and a restart loses nothing.
  async function handleMcp(req, res, body, auth, bearer) {
    const canWrite = hasScope(auth.scope, WRITE_SCOPE);
    const server = new McpServer({ name: "AKLA Hub", version: serverVersion }, {
      // The same sourcing rule the Hub's own assistant works under
      // (firmRules.js); get_firm_rules gives the full text.
      instructions: `Access to AKLA's Project Hub: the firm's projects and their documents, the precedent library and the law library (Pakistani statutes). Call get_firm_rules once at the start of a drafting or legal task and follow it. Before you draft or answer on a point that turns on what a law, a precedent or a project's documents say, look it up here first: search_precedents and search_law_library, and search_project_documents for a project; search before you say the firm lacks something, and never ask the lawyer to upload what the Hub may hold. Passages and sections are labelled [Source n], numbered from 1 in each result; cite them by number and the Act or document the label names, and quote statutory text only from a passage you have been shown (read_act_section gives the whole section). Every project, document and passage carries an "Open in Hub:" address; pass it on. Start with list_projects for project ids, then get_project_overview or list_project_documents for version ids (find_document_by_title finds one by name; search_everything finds a phrase across every project); list_acts and get_act_outline show what the law library holds; list_precedents, find_precedent_clauses and read_precedent are the precedent library whole; list_document_types, read_standard and get_drafting_decisions are the firm's standards, and open_standard_for_filling opens a type's Word standard with its blanks numbered for a fill. ${canWrite
        ? "Saving: the tools marked as not read-only save a new version of a document into a project (never over an existing version), fill the firm's Word standard with the facts gathered and file the result (fill_standard_to_project, after open_standard_for_filling and the drafting questions), or change one field of a project or document (its standing instructions, a version's label, a document's title or status, an empty document record, a re-read of a version); claude.ai asks the lawyer before each one, every one is recorded against the lawyer, and nothing here can delete anything. Saving is filing, not legal approval."
        : "This sign-in is read-only: nothing here can change or save a document (reconnecting the connector allows saving into projects)."}`,
    });
    // Write tools are listed only for a sign-in that carries hub:write. A
    // read-only sign-in that calls one anyway (an old conversation, a
    // guess) gets the one sentence below as a tool result, not the SDK's
    // "not found"; the tool is registered for that one request so the
    // listing stays clean (one server per request, so nothing persists).
    const called = body && !Array.isArray(body) && body.method === "tools/call" ? body.params?.name : null;
    const ctx = { userId: auth.userId, clientId: auth.clientId, scope: auth.scope, tokenId: auth.tokenId, canWrite, recheck: () => recheckBearer(bearer) };
    for (const t of tools) {
      const write = t.write === true;
      if (write && !canWrite && t.name !== called) continue;
      const refused = write && !canWrite;
      server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: refused ? WRITE : (t.annotations ?? READ_ONLY) }, async (args) => {
        if (refused) return { content: [{ type: "text", text: READ_ONLY_REFUSAL }], isError: true };
        try {
          const text = await t.run(args ?? {}, ctx);
          return { content: [{ type: "text", text }] };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `The ${write ? "save" : "lookup"} failed: ${reason}` }], isError: true };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function authorizeGet(req, res, url) {
    const params = Object.fromEntries(url.searchParams);
    let checked;
    try {
      checked = await checkAuthorizeRequest(store, params, { issuer: base });
    } catch (err) {
      if (err instanceof OAuthError && err.redirectable && typeof params.redirect_uri === "string") {
        const client = await store.getClient(String(params.client_id ?? ""));
        if (client?.redirect_uris?.includes(params.redirect_uri)) {
          return send(res, 302, "", { Location: redirectWith(params.redirect_uri, { error: err.code, error_description: err.message, state: params.state }) });
        }
      }
      if (err instanceof OAuthError) return html(res, 400, errorPage({ title: "This sign-in link is not valid", message: err.message }));
      throw err;
    }
    if (checked.ignoredScopes?.length) log(`authorize: client ${checked.client.id} asked for scope "${checked.ignoredScopes.join(" ")}" too; granting ${checked.scope} only`);
    return html(res, 200, signInPage({ fields: pick(params, AUTHORIZE_FIELDS), clientName: checked.client.client_name, redirectHost: checked.redirectHost, canWrite: hasScope(checked.scope, WRITE_SCOPE) }));
  }

  async function authorizePost(req, res) {
    const form = parseBody(await readBody(req), req.headers["content-type"]);
    const fields = pick(form, AUTHORIZE_FIELDS);
    let checked;
    try {
      checked = await checkAuthorizeRequest(store, fields, { issuer: base });
    } catch (err) {
      if (err instanceof OAuthError) return html(res, 400, errorPage({ title: "This sign-in link is not valid", message: err.message }));
      throw err;
    }
    const page = (extra) => html(res, 200, signInPage({ fields, email: String(form.email ?? ""), clientName: checked.client.client_name, redirectHost: checked.redirectHost, canWrite: hasScope(checked.scope, WRITE_SCOPE), ...extra }));
    const email = String(form.email ?? "").trim().toLowerCase();
    const ip = ipOf(req);
    const emailKey = `${email}|${ip}`;
    const wait = Math.max(signInByIp.check(ip), email ? signInByEmail.check(emailKey) : 0);
    if (wait) {
      log(`sign-in rate-limited for ${email || "(no email)"} from ${ip}`);
      return html(res, 429, errorPage({ status: 429, title: "Too many attempts", message: `Too many sign-in attempts. Wait ${Math.ceil(wait / 60)} minute${wait > 60 ? "s" : ""} and try again from claude.ai.` }));
    }
    const result = await signIn({ email, password: form.password, totp: form.totp });
    if (!result.ok) {
      if (result.reason !== "needs_totp") {
        log(`sign-in refused (${result.reason}) for ${email || "(no email)"} from ${ip}`);
        signInByIp.hit(ip);
        if (email) signInByEmail.hit(emailKey);
      }
      if (result.reason === "not_member") return html(res, 403, errorPage({ title: "This account cannot use the connector", message: result.message }));
      if (result.reason === "error") return html(res, 503, errorPage({ title: "Signing in did not work", message: result.message }));
      return page({ error: result.reason === "needs_totp" ? null : result.message, needsTotp: result.reason === "needs_totp" || result.reason === "bad_totp" });
    }
    const code = await issueCode(store, { client: checked.client, userId: result.userId, redirectUri: checked.redirectUri, codeChallenge: checked.codeChallenge, scope: checked.scope, resource: checked.resource }, { now });
    await store.touchClient(checked.client.id, now()).catch(() => {});
    log(`sign-in ok for ${email} (${result.userId}) from ${ip}, client ${checked.client.id}`);
    return send(res, 302, "", { Location: redirectWith(checked.redirectUri, { code, state: checked.state }), "Cache-Control": "no-store" });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, base);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "POST") {
      inFlight++;
      let counted = true;
      const done = () => { if (counted) { counted = false; inFlight--; } };
      res.on("close", done);
      res.on("finish", done);
    }
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, service: "hub-connector", inFlight, ...version });
      if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp")) return json(res, 200, docs.authorizationServer, { "Cache-Control": "public, max-age=3600" });
      if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) return json(res, 200, docs.protectedResource, { "Cache-Control": "public, max-age=3600" });
      if (path === "/oauth/about" || path === "/oauth") return html(res, 200, aboutPage({ mcpUrl: `${base}/mcp` }));

      if (path === "/oauth/register") {
        if (req.method !== "POST") return json(res, 405, { error: "invalid_request", error_description: "POST a client registration." });
        const ip = ipOf(req);
        if (registerByIp.check(ip)) return json(res, 429, { error: "too_many_requests", error_description: "Too many registrations from this address. Try again later." });
        registerByIp.hit(ip);
        try {
          const created = await registerClient(store, parseBody(await readBody(req), req.headers["content-type"], { jsonError: "invalid_client_metadata" }), { now, redirectHosts, allowLoopback });
          log(`client registered: ${created.client_id} (${created.client_name ?? "unnamed"}) for ${created.redirect_uris.join(" ")}`);
          return json(res, 201, created);
        } catch (err) { return oauthFail(res, err); }
      }

      if (path === "/oauth/authorize") {
        if (req.method === "GET") return await authorizeGet(req, res, url);
        if (req.method === "POST") return await authorizePost(req, res);
        return html(res, 405, errorPage({ title: "Not allowed", message: "Open this page from claude.ai." }));
      }

      if (path === "/oauth/token" || path === "/oauth/revoke") {
        if (req.method !== "POST") return json(res, 405, { error: "invalid_request", error_description: "POST only." });
        const ip = ipOf(req);
        if (tokenFailByIp.check(ip)) return json(res, 429, { error: "too_many_requests", error_description: "Too many failed requests from this address. Try again later." });
        try {
          const body = parseBody(await readBody(req), req.headers["content-type"]);
          const basic = parseAuthorization(req.headers.authorization);
          const clientAuth = basic.clientId ? { clientId: basic.clientId, clientSecret: basic.clientSecret } : {};
          if (path === "/oauth/revoke") {
            await revokeToken(store, body, { now, clientAuth, onFamilyRevoked: forgetFamily });
            return json(res, 200, {});
          }
          const tokens = await exchangeToken(store, body, { now, clientAuth, isMember: stillMember, onFamilyRevoked: forgetFamily, log });
          return json(res, 200, tokens);
        } catch (err) {
          if (err instanceof OAuthError) tokenFailByIp.hit(ip);
          return oauthFail(res, err);
        }
      }

      if (path === "/mcp") {
        const auth = await bearerOf(req);
        if (!auth) return challenge(res, parseAuthorization(req.headers.authorization).bearer ? "invalid_token" : null, "Sign in to AKLA Hub to use this connector.");
        if (!(await stillMember(auth.userId))) return challenge(res, "insufficient_scope", "Your Hub account is no longer an approved firm member.", 403);
        if (req.method !== "POST") return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless; POST each request to /mcp." }, id: null }, { Allow: "POST, OPTIONS" });
        let body;
        try { body = parseBody(await readBody(req, MAX_MCP_BODY_BYTES), req.headers["content-type"] ?? "application/json"); }
        catch (err) { return json(res, err?.status === 413 ? 413 : 400, { jsonrpc: "2.0", error: { code: -32700, message: err?.status === 413 ? err.message : "The request body is not JSON." }, id: null }); }
        return await handleMcp(req, res, body, auth, parseAuthorization(req.headers.authorization).bearer);
      }

      if (req.method === "GET" && path === "/") return html(res, 200, aboutPage({ mcpUrl: `${base}/mcp` }));
      return html(res, 404, errorPage({ title: "Not found", message: "There is nothing at this address." }));
    } catch (err) {
      log(`connector ${req.method} ${path} failed: ${err?.stack ?? err}`);
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      if (path.startsWith("/oauth/authorize")) return html(res, 500, errorPage({ title: "Something went wrong", message: "The connector hit a problem. Try again in a moment." }));
      return json(res, 500, { error: "server_error", error_description: "The connector hit a problem. Try again in a moment." });
    }
  };
}
