// The case-law research service's HTTP endpoint.
//
// A separate service from chat-service (the AI Workspace chat): different
// retrieval source, different page, different tables. It is deployed to the
// Oracle VM the same way — scp, systemd, a Caddy block on a DuckDNS name — and
// bound to localhost; see the sibling services' deploy.sh and Caddyfile.
//
// POST /caselaw streams the answer to one question over Server-Sent Events,
// with the same event vocabulary the web client already consumes from
// chat-service (meta / notice / delta / sources / done / error), so the
// frontend's SSE reader is reused rather than rewritten.
//
// Auth is a Supabase JWT plus the is_firm_member RPC, exactly as chat-service
// gates its endpoints. The attorney's question runs through the retrieval +
// ranking pipeline (validated against the live MCP) and then the answer
// composer. Persistence of threads/messages and the per-question audit trail
// is the next layer; this endpoint answers correctly without it.

import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { CaseLawMcpClient } from "./mcpClient.js";
import { researchQuestion } from "./pipeline.js";
import { composeAnswer } from "./answer.js";
import { makeStore, cacheAdapter } from "./store.js";
import { parseCase } from "./parse.js";

const PORT = Number(process.env.PORT ?? 8094);
const SERVER_STARTED_AT = new Date().toISOString();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY })) {
  if (!value) console.error(`caselaw-service: ${name} is not set`);
}

const db = SUPABASE_URL && SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// JWT + firm membership, the same gate chat-service applies. The caller's token
// proves who they are; every table this service will touch grants firm members.
async function authorize(authHeader) {
  if (!db) return { error: { status: 500, body: { error: "Service is not configured for auth" } } };
  const token = (authHeader ?? "").replace("Bearer ", "");
  if (!token) return { error: { status: 401, body: { error: "Unauthorized" } } };
  const { data: { user } = {}, error } = await db.auth.getUser(token);
  if (error || !user) return { error: { status: 401, body: { error: "Unauthorized" } } };
  const { data: isMember, error: memberError } = await db.rpc("is_firm_member", { _user_id: user.id });
  if (memberError) return { error: { status: 500, body: { error: "Could not check your firm membership" } } };
  if (!isMember) return { error: { status: 403, body: { error: "Your account is not an active member of this firm workspace." } } };
  return { user };
}

let deployedVersion = {};
try {
  deployedVersion = JSON.parse(readFileSync(new URL("./DEPLOYED_VERSION", import.meta.url), "utf8"));
} catch { /* running from a checkout, not a deploy */ }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error("Request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Answer one question, streaming SSE. The MCP client is per-request so its
// session and rate-gate are isolated. A heartbeat keeps the connection open
// through the long retrieval phase; aborting the client aborts the work.
async function handleCaselaw(req, res, user) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const requestedThreadId = typeof body.threadId === "string" ? body.threadId : null;
  if (question.length < 3) {
    res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ error: "Ask a question (at least a few words)." }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...corsHeaders,
  });
  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Abort the pipeline if the attorney closes the tab mid-search.
  const abort = new AbortController();
  req.on("close", () => abort.abort());
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": working\n\n"); }, 15_000);

  const store = makeStore(db);
  const client = new CaseLawMcpClient({ cache: cacheAdapter(store, parseCase) });
  let threadId = null, runId = null;

  try {
    // History and the audit trail persist alongside the answer, but a failure
    // to write them must never cost the lawyer the answer — so these run first
    // and their ids travel to the client, but every store call self-swallows.
    threadId = await store.ensureThread({ threadId: requestedThreadId, userId: user.id, title: question });
    await store.saveMessage({ threadId, role: "user", content: question, userId: user.id });
    runId = await store.startRun({ threadId, question, userId: user.id });

    send("meta", { question, threadId, startedAt: new Date().toISOString() });
    const { plan, ranked, tier, coverage } = await researchQuestion({
      client,
      question,
      signal: abort.signal,
      notice: (text) => send("notice", { text }),
    });

    if (abort.signal.aborted) {
      await store.finishRun({ runId, status: "stopped", tier, plan, coverage, ranked });
      return;
    }
    send("notice", { text: tier === "related" ? "Nothing squarely on point; drafting from the nearest authority…" : "Drafting the answer…" });

    let answerText = "";
    const { text, sources, stopReason, citationIssues } = await composeAnswer({
      question, ranked, tier, client,
      signal: abort.signal,
      onDelta: (t) => { answerText += t; send("delta", { text: t }); },
    });

    if (abort.signal.aborted) {
      // Persist the partial so a stopped answer is not lost.
      const msgId = await store.saveMessage({ threadId, role: "assistant", content: answerText, metadata: { tier, stopped: true }, userId: user.id });
      await store.finishRun({ runId, messageId: msgId, status: "stopped", tier, plan, coverage, ranked });
      return;
    }

    const sourcesForStore = sources.map((s) => ({
      n: s.n, caseId: s.caseId, title: s.title, citations: s.citations,
      court: s.court, year: s.year, outcome: s.outcome, url: s.url,
      relevance: s.relevance, overruled: s.overruled, citedByCount: s.citedByCount,
      grounding: s.grounding,
    }));
    const messageId = await store.saveMessage({
      threadId, role: "assistant", content: text,
      metadata: { tier, sources: sourcesForStore, citationIssues, plan: { issue: plan.issue, statutes: plan.statutes } },
      userId: user.id,
    });
    await store.finishRun({ runId, messageId, status: "complete", tier, plan, coverage, ranked });

    send("sources", { tier, messageId, sources: sourcesForStore });
    send("done", {
      tier,
      threadId,
      messageId,
      stopReason,
      plan: { issue: plan.issue, statutes: plan.statutes, variants: plan.variants, yearFrom: plan.yearFrom, yearTo: plan.yearTo, courts: plan.courts },
      coverage,
      // Surfaced, not hidden: if the model cited a source number that does not
      // exist, the UI should warn rather than present it as sound.
      citationIssues,
    });
  } catch (err) {
    if (!abort.signal.aborted) {
      await store.finishRun({ runId, status: "error", error: String(err.message ?? err).slice(0, 500) });
      send("error", { message: err.message ?? "Case-law research failed" });
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return; }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/version") {
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ ...deployedVersion, startedAt: SERVER_STARTED_AT }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/caselaw") {
    const auth = await authorize(req.headers.authorization);
    if (auth.error) {
      res.writeHead(auth.error.status, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify(auth.error.body));
      return;
    }
    await handleCaselaw(req, res, auth.user);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => console.log(`caselaw-service listening on 127.0.0.1:${PORT}`));
