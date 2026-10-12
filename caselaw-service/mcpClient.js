// Client for the Pakistan Case Law MCP server (https://pakistancaselaw.com/mcp).
//
// This is a free, read-only, no-auth endpoint that the operator explicitly
// opens to AI assistants doing per-question legal research (its robots.txt
// welcomes "any person or AI assistant searching and reading individual
// judgments for a user's research"). It holds 232k+ reported Pakistani
// judgments (Supreme Court, Federal Shariat Court, High Courts and tribunals,
// 1970 onward), each linked by a full citation graph.
//
// Transport is MCP "Streamable HTTP": every call is a JSON-RPC POST, the first
// call (initialize) returns an Mcp-Session-Id header we echo on every request
// after, and responses come back as a Server-Sent-Events stream whose last
// `data:` line is the JSON-RPC result. The operator rate-limits to 240 tool
// calls per minute per session and sets Retry-After on 429, so we serialise
// calls through a small spacing gate rather than risk tripping it.
//
// Policy, enforced here so no caller can forget it: we search and read
// individual judgments on demand for one attorney's question. We do NOT walk
// case ids, page through listings to collect judgments, or build a mirror —
// that is barred, and it is not what this feature does.

const ENDPOINT = process.env.CASELAW_MCP_URL ?? "https://pakistancaselaw.com/mcp";
const PROTOCOL_VERSION = "2025-03-26";

// 240/min = one every 250ms. We leave headroom at 300ms so parallel fan-out
// across query variants cannot collectively exceed the limit.
const MIN_CALL_SPACING_MS = 300;

export class CaseLawMcpError extends Error {
  constructor(message, { code, retryAfter } = {}) {
    super(message);
    this.name = "CaseLawMcpError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class CaseLawMcpClient {
  // `cache` (optional) is a { get(caseId, section), put(caseId, section, md) }
  // used by getCase to avoid re-fetching the same judgment within its TTL.
  constructor({ fetcher = fetch, timeoutMs = 30_000, cache = null } = {}) {
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.cache = cache;
    this.sessionId = null;
    this.nextId = 1;
    this.tools = null;
    // Serialises calls and spaces them out to stay under the rate limit.
    this.gate = Promise.resolve();
  }

  async #post(method, params) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const response = await this.fetcher(ENDPOINT, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });

    if (response.status === 429) {
      await response.body?.cancel();
      const retryAfter = Number(response.headers.get("retry-after") ?? 60);
      throw new CaseLawMcpError("Pakistan Case Law rate limit hit", {
        code: "RATE_LIMITED",
        retryAfter,
      });
    }
    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader) this.sessionId = sessionHeader;

    if (!response.ok) {
      await response.body?.cancel();
      throw new CaseLawMcpError(`Pakistan Case Law request failed (${response.status})`);
    }

    const raw = await response.text();
    const parsed = this.#parseStream(raw);
    if (parsed.error) {
      throw new CaseLawMcpError(parsed.error.message ?? "MCP error", {
        code: parsed.error.code,
      });
    }
    return parsed.result;
  }

  // The body is an SSE stream: zero or more "event:"/"data:" lines. The final
  // `data:` line carries the JSON-RPC envelope. A server that answers with a
  // bare JSON body instead is also accepted.
  #parseStream(raw) {
    const dataLines = [...raw.matchAll(/^data: (.*)$/gm)].map((m) => m[1]);
    const payload = dataLines.length ? dataLines[dataLines.length - 1] : raw;
    try {
      return JSON.parse(payload);
    } catch {
      throw new CaseLawMcpError("Could not parse MCP response");
    }
  }

  // Space calls out so concurrent fan-out stays under the per-minute limit.
  #schedule(fn) {
    const run = this.gate.then(async () => {
      const result = await fn();
      await new Promise((r) => setTimeout(r, MIN_CALL_SPACING_MS));
      return result;
    });
    // The gate advances even if this call rejects, so one failure does not
    // wedge the queue; the caller still sees the rejection via `run`.
    this.gate = run.then(() => {}, () => {});
    return run;
  }

  async initialize() {
    if (this.sessionId) return;
    await this.#post("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "akla-caselaw-service", version: "0.1.0" },
    });
    const listed = await this.#post("tools/list", {});
    this.tools = (listed.tools ?? []).map((t) => t.name);
  }

  // Call one tool and return its text content joined into a single string
  // (every tool here answers in markdown by default). `response_format: "json"`
  // is available on the get_* tools when a caller wants structured data.
  async call(name, args = {}) {
    await this.initialize();
    const result = await this.#schedule(() =>
      this.#post("tools/call", { name, arguments: args })
    );
    if (result.isError) {
      const text = (result.content ?? []).map((c) => c.text ?? "").join("");
      throw new CaseLawMcpError(text || `${name} failed`);
    }
    return (result.content ?? []).map((c) => c.text ?? "").join("");
  }

  // Convenience wrappers for the seven tools, so callers use names and typed
  // arguments rather than string literals.
  search(args) {
    return this.call("caselaw_search", args);
  }
  searchQuestions(args) {
    return this.call("caselaw_search_questions", args);
  }
  lookupCitation(args) {
    return this.call("caselaw_lookup_citation", args);
  }
  // Cached by (caseId, section) when a cache is configured. The cache stores
  // the markdown this returns, so a hit skips the rate-gated network call —
  // which is what makes follow-up questions in a thread cheap. Only the default
  // markdown format is cached; a JSON request always goes to the server.
  async getCase(caseId, section = "summary", responseFormat = "markdown") {
    if (this.cache && responseFormat === "markdown") {
      try {
        const hit = await this.cache.get(caseId, section);
        if (hit) return hit;
      } catch { /* cache read failure falls through to a live fetch */ }
    }
    const md = await this.call("caselaw_get_case", { case_id: caseId, section, response_format: responseFormat });
    if (this.cache && responseFormat === "markdown") {
      try { await this.cache.put(caseId, section, md); } catch { /* best-effort */ }
    }
    return md;
  }
  getCitations(caseId, args = {}) {
    return this.call("caselaw_get_citations", { case_id: caseId, ...args });
  }
  getCitedBy(caseId, args = {}) {
    return this.call("caselaw_get_cited_by", { case_id: caseId, ...args });
  }
  mostCited(args = {}) {
    return this.call("caselaw_most_cited", args);
  }
}
