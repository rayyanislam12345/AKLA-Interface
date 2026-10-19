// AKLA Hub for claude.ai: an MCP connector with its own OAuth, served on
// 127.0.0.1:8095 behind Caddy at https://aklachat.duckdns.org/mcp. It reads
// the Hub (hub:read) and, since slice 2, saves new versions into projects
// (hub:write: every save asks in claude.ai first and is recorded in
// connector_actions; nothing deletes).
//
//   node connector/connector.js         (systemd: hub-connector.service)
//
// Reads /opt/chat-service/.env, the same file as chat-service: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY, ANTHROPIC_API_KEY,
// VOYAGE_API_KEY. Its own settings, all optional: CONNECTOR_PORT (8095),
// CONNECTOR_ISSUER (https://aklachat.duckdns.org), CONNECTOR_REDIRECT_HOSTS
// (comma-separated hosts a client may be sent back to after sign-in;
// claude.ai,claude.com), CONNECTOR_HUB_URL (the site's address, for the
// "Open in Hub" lines on results; https://akla-interface.vercel.app) and
// CONNECTOR_ALLOW_LOOPBACK=1 (also http://localhost, for a dev box only).
// PORT is chat-service's and is ignored here.
//
// What it is made of: oauth.js (the authorization server), store.js (its
// tables), signIn.js (the Hub login, server-side), tools.js (what a lawyer's
// Claude can look up, plus every module under tools/), projectWrites.js
// (the one way a tool saves, the record and the caps), hubLinks.js (the
// links back to the site), app.js (the routes). See docs/claude-ai-connector.md.

import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import { createSupabaseStore } from "./store.js";
import { createSignIn } from "./signIn.js";
import { createHubTools, loadToolModules } from "./tools.js";
import { DEFAULT_HUB_URL } from "./hubLinks.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
const PORT = Number(process.env.CONNECTOR_PORT ?? 8095);
const ISSUER = (process.env.CONNECTOR_ISSUER ?? "https://aklachat.duckdns.org").replace(/\/+$/, "");
const REDIRECT_HOSTS = String(process.env.CONNECTOR_REDIRECT_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const HUB_URL = (process.env.CONNECTOR_HUB_URL ?? DEFAULT_HUB_URL).replace(/\/+$/, "");
const ALLOW_LOOPBACK = /^(1|true|yes)$/i.test(String(process.env.CONNECTOR_ALLOW_LOOPBACK ?? ""));

for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, VOYAGE_API_KEY: VOYAGE_KEY })) {
  if (!value) { console.error(`${name} is not set`); process.exit(1); }
}
if (!ANTHROPIC_KEY) console.warn("ANTHROPIC_API_KEY is not set: searches run without the question rewrite");

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// The same quick model call retrieve.js uses to rephrase a question
// (server.js anthropicJson); null when there is no key.
const anthropicJson = ANTHROPIC_KEY
  ? async (body, signal) => {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    if (!resp.ok) throw new Error(`The AI service didn't respond properly (${resp.status}).`);
    return resp.json();
  }
  : null;

let version = {};
try {
  version = JSON.parse(readFileSync(new URL("../DEPLOYED_VERSION", import.meta.url), "utf8"));
} catch { /* a checkout, not a deploy */ }

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

// The tool modules under connector/tools/ are read once here; one that
// will not load stops the start, which systemd reports.
const modules = await loadToolModules();

const app = createApp({
  store: createSupabaseStore(db),
  signIn: createSignIn({ supabaseUrl: SUPABASE_URL, publishableKey: PUBLISHABLE_KEY, serviceClient: db, log }),
  tools: createHubTools({ supabase: db, voyageKey: VOYAGE_KEY, anthropicJson, log, hubUrl: HUB_URL, modules }),
  isMember: async (userId) => {
    const { data, error } = await db.rpc("is_firm_member", { _user_id: userId });
    if (error) throw new Error(`is_firm_member: ${error.message}`);
    return data === true;
  },
  issuer: ISSUER,
  ...(REDIRECT_HOSTS.length ? { redirectHosts: REDIRECT_HOSTS } : {}),
  allowLoopback: ALLOW_LOOPBACK,
  version,
  log,
});
if (ALLOW_LOOPBACK) console.warn("CONNECTOR_ALLOW_LOOPBACK is set: http://localhost redirect URIs are accepted (dev only)");

const server = createServer((req, res) => { app(req, res); });
// A tool call can wait on a search for some seconds; a document read a
// little longer. Nothing here runs for minutes, so Node's defaults stand
// except the request timeout, which the streaming MCP responses would trip.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(PORT, "127.0.0.1", () => {
  log(`hub-connector listening on 127.0.0.1:${PORT} as ${ISSUER} (commit ${version.commit ?? "unknown"}); redirects allowed to ${(REDIRECT_HOSTS.length ? REDIRECT_HOSTS : ["claude.ai", "claude.com"]).join(", ")}; Hub links to ${HUB_URL}; ${modules.length} tool module${modules.length === 1 ? "" : "s"} loaded`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig}: closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
