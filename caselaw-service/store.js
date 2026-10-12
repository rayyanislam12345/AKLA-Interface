// Persistence for caselaw-service: threads, messages, the per-question audit
// trail, and the 30-day judgment cache. All writes go through the service-role
// Supabase client the server holds, for the same reason chat-service does it:
// a long run must not fail because the caller's browser token expired midway.
//
// Everything here is best-effort from the answer's point of view — a failed
// write is logged and swallowed so a database hiccup never costs the lawyer the
// answer that was already produced. The audit trail and history are valuable,
// but they are not worth failing a good answer over.

const CACHE_TTL_DAYS = Number(process.env.CASELAW_CACHE_TTL_DAYS ?? 30);
const CACHE_TTL_MS = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

export function makeStore(db) {
  if (!db) return nullStore();

  async function ensureThread({ threadId, userId, title }) {
    if (threadId) return threadId;
    const { data, error } = await db
      .from("caselaw_threads")
      .insert({ created_by: userId, title: title?.slice(0, 200) ?? null })
      .select("id")
      .single();
    if (error) { console.error(`caselaw store: create thread failed: ${error.message}`); return null; }
    return data.id;
  }

  async function saveMessage({ threadId, role, content, metadata = {}, userId }) {
    if (!threadId) return null;
    const { data, error } = await db
      .from("caselaw_messages")
      .insert({ thread_id: threadId, role, content, metadata, created_by: userId })
      .select("id")
      .single();
    if (error) { console.error(`caselaw store: save ${role} message failed: ${error.message}`); return null; }
    return data.id;
  }

  async function startRun({ threadId, question, userId }) {
    const { data, error } = await db
      .from("caselaw_runs")
      .insert({ thread_id: threadId, question, status: "running", created_by: userId })
      .select("id")
      .single();
    if (error) { console.error(`caselaw store: start run failed: ${error.message}`); return null; }
    return data.id;
  }

  async function finishRun({ runId, messageId, status, tier, plan, coverage, ranked, error }) {
    if (!runId) return;
    const { error: e } = await db
      .from("caselaw_runs")
      .update({ message_id: messageId ?? null, status, tier: tier ?? null, plan: plan ?? null, coverage: coverage ?? null, ranked: ranked ?? null, error: error ?? null })
      .eq("id", runId);
    if (e) console.error(`caselaw store: finish run failed: ${e.message}`);
  }

  // Judgment cache: returns the stored markdown body if a fresh row exists,
  // else null. Keyed by (case_id, section). A stale row (older than the TTL)
  // is treated as a miss so the caller re-fetches.
  async function cacheGet(caseId, section) {
    const { data, error } = await db
      .from("caselaw_cache")
      .select("body, fetched_at")
      .eq("case_id", caseId)
      .eq("section", section)
      .maybeSingle();
    if (error || !data) return null;
    if (Date.now() - new Date(data.fetched_at).getTime() > CACHE_TTL_MS) return null;
    return data.body;
  }

  // Store a fetched judgment. `fields` carries parsed metadata for queryability;
  // `body` is the raw markdown the client returned, which is what cacheGet
  // replays. Upsert so a refresh overwrites the stale row and its fetched_at.
  async function cachePut(caseId, section, body, fields = {}) {
    const { error } = await db
      .from("caselaw_cache")
      .upsert({
        case_id: caseId,
        section,
        body,
        citation: fields.citation ?? null,
        court: fields.court ?? null,
        year: Number.isInteger(fields.year) ? fields.year : null,
        title: fields.title ?? null,
        fetched_at: new Date().toISOString(),
      }, { onConflict: "case_id,section" });
    if (error) console.error(`caselaw store: cache put failed: ${error.message}`);
  }

  return { ensureThread, saveMessage, startRun, finishRun, cacheGet, cachePut };
}

// When the service has no database configured (local dev), everything no-ops
// and the cache always misses, so the pipeline still runs end to end.
function nullStore() {
  return {
    ensureThread: async ({ threadId }) => threadId ?? null,
    saveMessage: async () => null,
    startRun: async () => null,
    finishRun: async () => {},
    cacheGet: async () => null,
    cachePut: async () => {},
  };
}

// Wrap a store's cache into the { get, put } shape CaseLawMcpClient.getCase
// consults, parsing the fetched markdown for the metadata columns. parseCase is
// injected to avoid a circular import.
export function cacheAdapter(store, parseCase) {
  return {
    async get(caseId, section) {
      return store.cacheGet(caseId, section);
    },
    async put(caseId, section, markdown) {
      const p = parseCase(markdown);
      await store.cachePut(caseId, section, markdown, { citation: p.citations?.[0] ?? null, court: p.court, year: p.year, title: p.title });
    },
  };
}
