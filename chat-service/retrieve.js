// One search for everything the assistant looks up: the chat's automatic
// search, its library tools (search_law_library, search_precedents,
// search_project_documents), and the evidence a review is given.
//
// Until now each path embedded the question once and took the nearest rows
// from match_documents: no words matched, a superseded draft answered as
// readily as the current one, one long file could fill every slot, and a
// source was labelled with a file name alone. retrieve() does, for one scope
// ("project" | "precedent" | "statute"):
//
//   1. For a precedent or statute question (not a pasted document), a quick
//      model call rewrites it into two or three phrasings in the words the
//      clause or the statute would use ("is an LD clause a penalty" →
//      "compensation for breach of contract where penalty stipulated for").
//      Not for a question that names a section, quotes exact words, or is
//      under four words: those are searched as asked. Cached per question.
//   2. One embedding call (voyage-law-2, query) per search: the rewrite is
//      waited for up to REWRITE_WAIT_MS from the start, then the question
//      and its phrasings are embedded together; a late or skipped rewrite
//      means the question alone. Embeddings are kept (500, for an hour), so
//      a question asked again, or by the chat's other scopes at the same
//      moment, costs no call, and its search starts at once. A late rewrite
//      is still cached for the next time the question is asked.
//   3. search_passages (supabase/migrations/20261017120000_hybrid_search.sql,
//      made faster by 20261018120000_hybrid_search_speed.sql)
//      per phrasing, all at once: meaning, words and file names, fused by
//      reciprocal rank in SQL, current versions only, at most three passages
//      a file.
//   4. The phrasings' lists merged (each passage keeps its best fused
//      score), repeated text dropped, three a file again, and the best 30
//      reranked by Voyage rerank-2 against the question, each by its
//      8,000 characters around the question's words; on any rerank failure
//      the fused order stands. No rerank when the merged list already fits
//      in k, nor for a project search with at most twice k passages.
//   5. Each passage labelled for citation: "Term Sheet v3, 4.2 Concession
//      Period", "12. JVA.docx, cl. 9.1", "Contract Act, 1872, s.74". A
//      statute passage is placed in its section in its Act's rebuilt text
//      (libraryTools.actText, kept an hour); the Acts the best passages come
//      from are read while the reranker works, and in parallel.
//
// A question that names a section of an Act it can identify ("section 208 of
// the Companies Act 2017") also gets that section's full text first, read the
// way read_act_section reads it, from the start, alongside the search.
//
// A deadline (deadlineMs, default RETRIEVE_DEADLINE_MS = 12 s) is a hard
// total: retrieve() returns within deadlineMs + FALLBACK_GRACE_MS, whatever
// the services are doing. Under a deadline a search by words alone (the same
// search_passages call with no embedding: its keyword and file-name legs,
// which need no Voyage call) starts at once, beside the rewrite and the
// embedding, so that something is in hand when the embedding is slow — on
// the free tier a Voyage call can wait 7-15 s. At the deadline the search
// returns the best it has: the full search when it has finished (path
// "full"); else the question's own search_passages result, words and
// meaning fused but not reranked ("fused"); else the words-only result
// ("words"); and only when none is back, nothing ("none"). A full search
// that fails before the deadline (a statement timeout, say) returns the
// same way when a quicker result is in hand. A quick return is marked
// fellBack with the reason, the reranker is never run on it, nothing that
// finishes later changes what was returned, and the rest (the reranker and
// any search still running) is aborted.
//
// The Voyage account is on the free tier (3 requests a minute): every call
// counts, and a search makes at most two (one embedding, one rerank), often
// fewer. `voyageCalls` counts them.
//
// `timings: true` returns, with the passages, when each stage started and how
// long it took, with fellBack, reason, path and voyageCalls
// (scripts/eval/time-retrieve.mjs prints them; run.mjs writes them into its
// results file).
//
// Deploying this before the migration is safe: when search_passages is not
// in the database, the same flow runs on match_documents (meaning only) and
// the current-version filter is applied here instead.
//
// The VM runs Node 20: nothing newer is used.

import { findPassages, sectionAt, actText, listActs, sameLaw, readActSection, parseSection } from "./libraryTools.js";
import { paragraphsOf, termHits, queryTerms } from "./precedentSearch.js";
import { parseLabel } from "./indexing/chunk.js";
import { actKey } from "./research.js";

export const SCOPES = new Set(["project", "precedent", "statute"]);
export const RRF_K = 60;
export const FILE_CAP = 3;
export const CANDIDATES = 40;
// How many fused passages the reranker reads, and how much of each. The
// 60-question test held its score at 30 × 8,000 (a passage is shown as at
// most 4,000 characters, so all of it); 20 × 1,500 was quicker but dropped
// statute-concept recall from 87% to 73%. Both can be set per call
// (rerankPool, rerankChars) to compare.
export const RERANK_POOL = 30;
export const RERANK_CHARS = 8_000;
// How long from the start of a search the rewrite's phrasings are waited
// for before the question (and the phrasings, if they came) are embedded.
export const REWRITE_WAIT_MS = 2_500;
// How long a search may take before it returns the quick way (see above).
// RETRIEVE_DEADLINE_MS in the environment sets it; 0 turns it off.
export const RETRIEVE_DEADLINE_MS = (() => {
  const raw = String(process.env.RETRIEVE_DEADLINE_MS ?? "").trim();
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? v : 12_000;
})();
// After the deadline, how long a search about to answer is still waited for
// when nothing is back: retrieve() returns within the deadline plus this.
export const FALLBACK_GRACE_MS = 300;
// Statute passages are placed in their sections for the first few Acts.
const PLACE_ACTS = 3;
// The rerank-2 score under which a passage found automatically (the chat's
// own search, review evidence) is left out, so a message with nothing
// relevant in a library is not handed that library's nearest unrelated text.
// A first setting, not yet calibrated: the retrieval evaluation records each
// passage's score (scripts/eval/run.mjs --adapter retrieve), so set it from
// the scores of passages that answer and those that do not. The tools ask
// with no floor: the assistant chose to look.
export const MIN_RELEVANCE = 0.2;
// A passage longer than this is shown as its best window.
export const MAX_TEXT = 4_000;
const WINDOW = 3_000;
// Longer than this, a query is a document (a review segment, a long chat
// turn), not a question: it is not rewritten, and its keyword search uses
// its most telling words.
const MAX_QUESTION_CHARS = 600;
const LONG_QUERY = 300;
const REWRITE_TIMEOUT_MS = 6_000;
// The embedding call's own timeout. It does not bound a search: under a
// deadline the search returns without it (the call is shared through the
// cache, so a late embedding still serves the next question).
const EMBED_TIMEOUT_MS = 15_000;
const CACHE_MS = 60 * 60 * 1000;
const MAX_CACHE = 500;
const MISSING_RETRY_MS = 60 * 1000;
const EMBED_URL = "https://api.voyageai.com/v1/embeddings";
const RERANK_URL = "https://api.voyageai.com/v1/rerank";
const PATH_SEPARATOR = " › ";

export const SECTION_RE = /\b(?:sections?|sectoin|sec\.?|s\.|s|rule|article|art\.)\s*(\d{1,4}[A-Za-z]?)\b/i;

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const noop = () => {};

// ---------------------------------------------------------------------------
// Caches: embeddings and rewrites, per text, for an hour, the 500 used
// most recently (a Map keeps insertion order: a hit is moved to the end, the
// first entry is the least recently used).

const embedCache = new Map();
const rewriteCache = new Map();
let hybridMissingUntil = 0;

function remember(cache, key, value) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return value;
}
function recall(cache, key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_MS) { cache.delete(key); return undefined; }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}
const embedKey = (text) => String(text).slice(0, 8000);

/** Forget cached embeddings, rewrites and the "migration not applied" note (tests). */
export function clearRetrieveCaches() {
  embedCache.clear();
  rewriteCache.clear();
  hybridMissingUntil = 0;
}

// ---------------------------------------------------------------------------
// Fusion, caps and labels: pure

export const rrfOf = (rank) => (Number.isInteger(rank) && rank > 0 ? 1 / (RRF_K + rank) : 0);

/**
 * Several ranked lists of the same passages (one per phrasing) as one list:
 * each passage keeps its best fused score (`rrf`) and its best leg ranks;
 * a passage found by more phrasings wins a tie (`rrfSum`), then the earlier
 * list and position.
 */
export function fuseLists(lists) {
  const byKey = new Map();
  let order = 0;
  for (const list of lists ?? []) {
    for (const c of list ?? []) {
      if (!c || c.key == null) continue;
      const score = typeof c.rrf === "number" && Number.isFinite(c.rrf) ? c.rrf : 0;
      const have = byKey.get(c.key);
      if (!have) {
        byKey.set(c.key, { ...c, rrf: score, rrfSum: score, phrasings: 1, order: order++ });
        continue;
      }
      have.rrfSum += score;
      have.phrasings += 1;
      const min = (a, b) => (a == null ? b ?? null : b == null ? a : Math.min(a, b));
      have.vectorRank = min(have.vectorRank, c.vectorRank);
      have.keywordRank = min(have.keywordRank, c.keywordRank);
      have.nameRank = min(have.nameRank, c.nameRank);
      if (score > have.rrf) have.rrf = score;
    }
  }
  return [...byKey.values()].sort((a, b) => b.rrf - a.rrf || b.rrfSum - a.rrfSum || a.order - b.order);
}

/** At most `cap` passages from one file, order kept. */
export function capPerFile(items, cap = FILE_CAP, fileOf = (c) => c.fileKey ?? c.key) {
  if (!Number.isFinite(cap)) return [...items];
  const seen = new Map();
  const out = [];
  for (const c of items) {
    const f = fileOf(c);
    const n = seen.get(f) ?? 0;
    if (n >= cap) continue;
    seen.set(f, n + 1);
    out.push(c);
  }
  return out;
}

/** The same words twice (two copies of an Act, a precedent filed twice): the first is kept. */
export function dedupeByText(items) {
  const seen = new Set();
  return items.filter((c) => {
    const t = norm(c.content ?? c.text).toLowerCase().slice(0, 300);
    if (!t) return true;
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
}

/** "Article 14 Termination › 14.2 Termination for convenience" → its last two entries, at most ~100 characters. */
export function shortHeading(path) {
  const parts = String(path ?? "").split(PATH_SEPARATOR).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  let out = parts.slice(-2).join(PATH_SEPARATOR);
  if (out.length > 100) out = parts[parts.length - 1];
  return out.length > 100 ? `${out.slice(0, 97).trimEnd()}…` : out;
}

/** A section number from a statute passage's heading path ("Part VI › 73. Compensation …" → "73"). */
export function sectionFromHeading(path) {
  const parts = String(path ?? "").split(PATH_SEPARATOR).map((s) => s.trim()).filter(Boolean).reverse();
  for (const p of parts) {
    const m = /^(?:sections?\s+|s\.\s*)?(\d{1,4}[A-Z]{0,3})\.?(?:\s|$)/i.exec(p);
    if (m && !/^(?:part|chapter|schedule)\b/i.test(p)) return m[1].toUpperCase();
  }
  return null;
}

/** The clause a precedent paragraph opens with: "cl. 9.1", "Article 14", or null. */
export function clauseOf(text) {
  const first = String(text ?? "").trim().split(/\n/)[0].slice(0, 200);
  const label = parseLabel(first);
  if (!label) return null;
  if (label.kind === "clause") return `cl. ${label.label.replace(/\.$/, "")}`;
  if (label.kind === "article" || label.kind === "part") return label.label;
  return null;
}

/**
 * How a passage is cited:
 *   project   → "<document title> v<N>, <heading path or p. N>"
 *   precedent → "<file name>, <heading path or clause>"
 *   statute   → "<Act>, s.<N>"
 */
export function buildLabel(p) {
  if (p.scope === "statute") {
    const act = p.act_name || "Statute";
    return p.section ? `${act}, s.${p.section}` : act;
  }
  if (p.scope === "project") {
    const title = p.title || p.filename || "Project document";
    const head = `${title}${p.version_number ? ` v${p.version_number}` : ""}`;
    const where = shortHeading(p.heading_path) || (p.page ? `p. ${p.page}` : "");
    return where ? `${head}, ${where}` : head;
  }
  const name = p.filename || p.title || "Precedent";
  const where = shortHeading(p.heading_path) || clauseOf(p.text ?? p.content);
  return where ? `${name}, ${where}` : name;
}

const STOP = new Set(("the a an of and or to in for on by with that this these those is are be been as at from any all shall may will such "
  + "which who whom whose it its their there here hereby herein hereof hereto hereunder thereof therein thereto than then into upon under "
  + "other others including include includes provided provide pursuant accordance respect each every not no nor but if so also "
  + "party parties agreement agreements clause clauses section sections document documents").split(" "));

/** The words a long text is searched for by keyword: its dozen most telling, in order of first use. */
export function keywordText(query, max = 12) {
  const q = norm(query);
  if (q.length <= LONG_QUERY) return q;
  const counts = new Map();
  const first = new Map();
  let i = 0;
  for (const m of q.toLowerCase().matchAll(/[a-z][a-z0-9-]{2,}/g)) {
    const w = m[0];
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
    if (!first.has(w)) first.set(w, i++);
  }
  return [...counts.entries()]
    .map(([w, n]) => ({ w, score: n * Math.log(w.length) }))
    .sort((a, b) => b.score - a.score || first.get(a.w) - first.get(b.w))
    .slice(0, max)
    .sort((a, b) => first.get(a.w) - first.get(b.w))
    .map((x) => x.w)
    .join(" ");
}

/**
 * What the model reads of a passage: all of it, or the best window of a long
 * one — where the words of the question, or of whichever phrasing matches
 * it best, cluster.
 */
export function passageText(content, queries) {
  const text = norm(content);
  if (text.length <= MAX_TEXT) return { text, anchorText: text.slice(0, 200) };
  let best = null;
  for (const q of Array.isArray(queries) ? queries : [queries]) {
    const [w] = findPassages(text, q, { max: 1, window: WINDOW });
    if (w && (!best || w.score > best.score)) best = w;
  }
  if (best) return { text: text.slice(best.start, best.end), anchorText: text.slice(best.anchor, best.anchor + 200) };
  return { text: text.slice(0, WINDOW), anchorText: text.slice(0, 200) };
}

/** Whether an RPC error means search_passages is not (fully) in the database yet. */
export function isMissingFunction(err) {
  if (!err) return false;
  const code = String(err.code ?? "");
  const msg = String(err.dbMessage ?? err.message ?? "");
  if (code === "PGRST202" || code === "42883" || code === "42703") return true;
  return /search_passages/i.test(msg) && /could not find|does not exist|schema cache/i.test(msg);
}

/**
 * The library Act a question names, from `names`: every subject word of the
 * name in the question ("companies act 2017", "PPRA rules"), its year agreeing
 * when the question gives one. Null when none or the match is unclear.
 */
export function namedAct(query, names) {
  const q = ` ${String(query ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const askedYears = q.match(/ (?:18|19|20)\d{2} /g)?.map((y) => y.trim()) ?? [];
  let best = null;
  for (const name of names ?? []) {
    const key = actKey(name);
    const words = key.words.filter((w) => !["act", "ordinance", "rules", "regulations", "order", "code"].includes(w));
    const aliases = [...String(name).matchAll(/\(([A-Za-z]{2,8})\)/g)].map((m) => m[1].toLowerCase());
    const aliasHit = aliases.some((a) => q.includes(` ${a} `));
    if (!aliasHit && (!words.length || !words.every((w) => q.includes(` ${w} `)))) continue;
    if (askedYears.length && key.years.length && !key.years.some((y) => askedYears.includes(y))) continue;
    const score = words.length + (key.years.some((y) => askedYears.includes(y)) ? 1 : 0) + (aliasHit ? 1 : 0);
    if (!best || score > best.score) best = { name, score };
  }
  return best?.name ?? null;
}

// ---------------------------------------------------------------------------
// The services

// The texts' embeddings, in one call for those not already kept (or being
// fetched): { vectors, sent } — sent is how many texts the call carried (0:
// no call made).
async function embedQueries(voyageKey, texts, { fetchImpl, signal }) {
  if (!voyageKey) throw new Error("no embedding key");
  const keys = texts.map(embedKey);
  const missing = [...new Set(keys.filter((t) => recall(embedCache, t) === undefined))];
  if (missing.length) {
    const call = (async () => {
      // Not tied to one search's deadline (others may be waiting on the
      // same call), only to the caller and a timeout of its own.
      const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
      const resp = await fetchImpl(EMBED_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${voyageKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "voyage-law-2", input: missing, input_type: "query" }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!resp.ok) throw new Error(`the search service did not respond (${resp.status})`);
      const rows = [...((await resp.json())?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== missing.length) throw new Error("the search service returned the wrong number of embeddings");
      return rows.map((r) => r.embedding);
    })();
    const each = missing.map((t, i) => {
      const p = call.then((v) => v[i]);
      p.catch(noop); // handled by whoever awaits it
      return remember(embedCache, t, p);
    });
    // A failed call is not remembered.
    call.catch(() => missing.forEach((t, i) => { if (embedCache.get(t)?.value === each[i]) embedCache.delete(t); }));
  }
  return { vectors: await Promise.all(keys.map((t) => recall(embedCache, t))), sent: missing.length };
}

const REWRITE_SYSTEM = {
  precedent: "You rewrite a lawyer's search over a Pakistani law firm's precedent agreements (concession, EPC, power and energy purchase, financing, shareholder, joint venture and track access agreements, MOUs). Reply with ONLY a JSON array of 2 or 3 strings, each a different search phrasing in the words a drafter writes in the clause itself: first the plain core term on its own (e.g. \"extension of time\"), then one or two short phrasings of the clause's operative wording (e.g. \"entitled to an extension of the time for completion\"). Expand abbreviations the way project and construction contracts use them — LD/LDs = liquidated damages, FM = force majeure, CP = conditions precedent, COD = commercial operations date, EoT = extension of time, DSCR = debt service coverage ratio, PPA = power purchase agreement, EPA = energy purchase agreement, SHA = shareholders agreement, JVA = joint venture agreement — never from another field. Correct misspellings. Keep any party, project or file name the query gives. No commentary.",
  statute: "You rewrite a lawyer's question for a search over the text of Pakistani statutes (Acts, Ordinances, Rules, Regulations). Reply with ONLY a JSON array of 2 or 3 strings, each a phrasing in the words the statute itself would use for the rule that answers the question — e.g. for \"can my agent hand the work to someone else\": [\"sub-agent\", \"agent cannot lawfully employ another to perform acts which he has expressly or impliedly undertaken to perform personally\"]. Use statutory vocabulary, correct misspellings, name the Act only when you are sure of it, and never invent section numbers. No commentary.",
};

/** Two or three phrasings of a question in the words a clause or statute would use; [] when no model is at hand. */
export async function rewriteQuery({ anthropicJson, query, scope, signal }) {
  if (!anthropicJson || !REWRITE_SYSTEM[scope]) return [];
  const q = norm(query);
  const key = `${scope}\u0000${q}`;
  const cached = recall(rewriteCache, key);
  if (cached !== undefined) return cached;
  const call = (async () => {
    let timer;
    try {
      const reply = await Promise.race([
        anthropicJson({
          model: process.env.RESEARCH_MODEL ?? "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system: REWRITE_SYSTEM[scope],
          messages: [{ role: "user", content: q.slice(0, MAX_QUESTION_CHARS) }],
        }, signal),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("rewrite timed out")), REWRITE_TIMEOUT_MS); }),
      ]);
      const text = (reply?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      const parsed = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? "[]");
      if (!Array.isArray(parsed)) return [];
      const lower = q.toLowerCase();
      return [...new Set(parsed.filter((p) => typeof p === "string").map(norm).filter((p) => p.length > 1 && p.length <= 300 && p.toLowerCase() !== lower))].slice(0, 3);
    } finally {
      clearTimeout(timer);
    }
  })();
  remember(rewriteCache, key, call);
  try {
    return await call;
  } catch (err) {
    rewriteCache.delete(key);
    if (signal?.aborted) throw err;
    console.error(`query rewrite skipped: ${err.message}`);
    return [];
  }
}

/**
 * What the reranker reads of a passage: all of it, or its best `max`
 * characters — where the words of the question, or of whichever phrasing
 * matches best, cluster (as passageText picks a window); failing that, around
 * its anchor, a third before and two thirds after; whole words at both ends.
 */
export function rerankText(p, max = RERANK_CHARS, queries = null) {
  const text = String(p.text ?? "");
  if (!(max > 0) || text.length <= max) return text;
  let best = null;
  for (const q of queries ?? []) {
    const [w] = findPassages(text, q, { max: 1, window: max });
    if (w && (!best || w.score > best.score)) best = w;
  }
  if (best) return text.slice(best.start, best.end);
  const at = p.anchorText ? text.indexOf(p.anchorText) : -1;
  let start = at > 0 ? Math.max(0, Math.min(at - Math.round(max / 3), text.length - max)) : 0;
  let end = Math.min(text.length, start + max);
  if (start > 0) start = text.indexOf(" ", start) + 1 || start;
  const space = text.lastIndexOf(" ", end);
  if (end < text.length && space > start) end = space;
  return text.slice(start, end);
}

/**
 * Voyage rerank-2 over the passages against the question: the best `k`, each
 * with `rerankScore`. Each passage is sent as its label and rerankText(p,
 * maxChars, queries) (queries: the question and its phrasings; default the
 * question). Any failure keeps the order given (`reranked: false`).
 */
export async function rerankPassages({ voyageKey, query, passages, k, maxChars = RERANK_CHARS, queries = null, fetchImpl = globalThis.fetch, signal }) {
  const keep = { passages: passages.slice(0, k), reranked: false };
  if (!voyageKey || passages.length < 2) return keep;
  try {
    const resp = await fetchImpl(RERANK_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${voyageKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "rerank-2",
        query: String(query).slice(0, 8000),
        documents: passages.map((p) => `${p.label ? `${p.label}\n\n` : ""}${rerankText(p, maxChars, queries ?? [query])}`.slice(0, 8000)),
        top_k: Math.min(k, passages.length),
        truncation: true,
      }),
      signal,
    });
    if (!resp.ok) throw new Error(`rerank failed (${resp.status})`);
    const rows = (await resp.json())?.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error("rerank returned nothing");
    const seen = new Set();
    const picked = [];
    for (const r of rows) {
      const i = Number(r?.index);
      const score = Number(r?.relevance_score);
      if (!Number.isInteger(i) || i < 0 || i >= passages.length || seen.has(i) || !Number.isFinite(score)) continue;
      seen.add(i);
      picked.push({ ...passages[i], rerankScore: score });
    }
    if (!picked.length) throw new Error("rerank returned no usable result");
    picked.sort((a, b) => b.rerankScore - a.rerankScore);
    return { passages: picked.slice(0, k), reranked: true };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error(`rerank skipped, keeping the fused order: ${err.message}`);
    return keep;
  }
}

// ---------------------------------------------------------------------------
// Searching

const fileKeyOf = (scope, c) => {
  if (scope === "statute") return c.act_name ?? c.storage_path ?? c.documentId;
  if (scope === "project") return c.document_version_id ?? c.storage_path ?? c.documentId;
  return c.storage_path ?? c.documentId;
};

/** A search_passages row as a candidate. */
export function toCandidate(row, scope) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const ordinal = meta.passage_ordinal;
  const c = {
    // precedent:<storage path>:<row>:<paragraph> — the shape the tools'
    // precedent ids have always had (the evaluation reads the path from it).
    key: scope === "precedent" && ordinal != null ? `precedent:${meta.storage_path ?? meta.filename ?? row.id}:${row.id}:${ordinal}` : String(row.id),
    documentId: row.id,
    scope,
    content: String(row.content ?? ""),
    metadata: meta,
    heading_path: row.heading_path ?? meta.heading_path ?? null,
    page: row.page ?? meta.page ?? null,
    document_version_id: row.document_version_id ?? null,
    matter_document_id: row.matter_document_id ?? null,
    version_number: row.version_number ?? null,
    storage_path: meta.storage_path ?? null,
    filename: meta.filename ?? null,
    title: meta.document_title ?? null,
    act_name: meta.act_name ?? null,
    url: meta.source_url ?? meta.pdf_url ?? null,
    vectorRank: row.vector_rank ?? null,
    keywordRank: row.keyword_rank ?? null,
    nameRank: row.name_rank ?? null,
    rrf: typeof row.rrf_score === "number" ? row.rrf_score : Number(row.rrf_score) || 0,
  };
  c.fileKey = fileKeyOf(scope, c);
  return c;
}

// An RPC, stopped when `signal` aborts (supabase-js's abortSignal), tried
// once more after a statement timeout.
async function callRpc(supabase, name, params, signal) {
  const call = () => {
    const b = supabase.rpc(name, params);
    return signal && typeof b?.abortSignal === "function" ? b.abortSignal(signal) : b;
  };
  let r = await call();
  if (r.error && /statement timeout/i.test(r.error.message ?? "") && !signal?.aborted) r = await call();
  return r;
}

async function hybridSearch(supabase, params, signal) {
  const r = await callRpc(supabase, "search_passages", params, signal);
  if (r.error) {
    const err = new Error(`The search failed: ${r.error.message}`);
    err.code = r.error.code;
    err.dbMessage = r.error.message;
    throw err;
  }
  return (r.data ?? []).map((row) => toCandidate(row, params.scope));
}

// The current version of each project document, by storage path, for the
// match_documents fallback (search_passages does this in SQL). Null when it
// cannot be read: nothing is filtered then.
async function projectVersions(supabase, matterId) {
  try {
    const { data, error } = await supabase
      .from("matter_documents")
      .select("id, title, versions:document_versions(id, version_number, storage_path, is_ai_generated, file_name)")
      .eq("matter_id", matterId);
    if (error) throw new Error(error.message);
    const byPath = new Map();
    for (const doc of data ?? []) {
      const versions = [...(doc.versions ?? [])].sort((a, b) => b.version_number - a.version_number);
      const current = versions.find((v) => !v.is_ai_generated);
      for (const v of versions) byPath.set(v.storage_path, { versionId: v.id, versionNumber: v.version_number, documentId: doc.id, title: doc.title, current: v === current });
    }
    return byPath;
  } catch (err) {
    console.error(`could not read project versions for the search: ${err.message}`);
    return null;
  }
}

// The paragraph of a whole-agreement precedent row that holds most of the
// question's words (its first when none does).
function bestParagraph(content, terms) {
  const paragraphs = paragraphsOf(String(content ?? "").slice(0, 1_500_000));
  let best = null;
  for (const p of paragraphs) {
    const hits = termHits(p.text, terms).count;
    if (!best || hits > best.hits) best = { ...p, hits };
  }
  return best;
}

async function vectorFallback(supabase, { scope, embedding, matterId, actNames, documentTypeId, allVersions, excludeDocumentId, candidates, terms, versions, signal }) {
  const params = { query_embedding: embedding, match_threshold: 0.3, match_count: candidates };
  if (scope === "project") params.filter_matter_id = matterId;
  if (scope === "precedent") params.precedent_only = true;
  if (scope === "statute") {
    params.statute_only = true;
    if (actNames?.length) params.filter_act_names = actNames;
  }
  if (documentTypeId) params.filter_document_type_id = documentTypeId;
  const r = await callRpc(supabase, "match_documents", params, signal);
  if (r.error) throw new Error(`The search failed: ${r.error.message}`);
  const out = [];
  for (const row of r.data ?? []) {
    const meta = row.metadata ?? {};
    let content = String(row.content ?? "");
    let key = String(row.id);
    let extra = {};
    if (scope === "project" && versions) {
      const v = versions.get(meta.storage_path);
      if (!v) continue; // a passage of a version that no longer exists
      if (!allVersions && !v.current) continue;
      if (excludeDocumentId && v.documentId === excludeDocumentId) continue;
      extra = { document_version_id: v.versionId, matter_document_id: v.documentId, version_number: v.versionNumber, document_title: v.title };
    }
    if (scope === "precedent") {
      const p = bestParagraph(content, terms);
      if (p) { content = p.text; key = `precedent:${meta.storage_path ?? meta.filename ?? row.id}:${row.id}:o${p.offset}`; }
    }
    const rank = out.length + 1;
    const c = toCandidate({
      id: row.id, content, metadata: { ...meta, ...(extra.document_title ? { document_title: extra.document_title } : {}) },
      document_version_id: extra.document_version_id ?? null, matter_document_id: extra.matter_document_id ?? null, version_number: extra.version_number ?? null,
      vector_rank: rank, keyword_rank: null, name_rank: null, rrf_score: rrfOf(rank),
    }, scope);
    c.key = key;
    c.similarity = typeof row.similarity === "number" ? row.similarity : null;
    out.push(c);
  }
  return out;
}

// The copies of each named law the library holds ("Companies Act, 2017" may
// be held under two titles).
async function expandActs(supabase, names) {
  try {
    const acts = await listActs(supabase);
    return [...new Set(names.flatMap((n) => sameLaw(n, acts)))];
  } catch {
    return names;
  }
}

// The Acts whose passages need placing in their sections (no section from
// the heading path), in the passages' order, at most `max`.
function actsToPlace(passages, max = PLACE_ACTS) {
  return [...new Set(passages.filter((p) => !p.section && !sectionFromHeading(p.heading_path) && p.act_name).map((p) => p.act_name))].slice(0, max);
}

// Statute passages placed in their sections: from the heading path, else by
// finding the passage in its Act's rebuilt text (as search_law_library does),
// for the first three Acts involved, those Acts read at once (an Act already
// being read, or read in the last hour, is not read again: actText).
async function placeSections(supabase, passages, clock = null) {
  for (const p of passages) if (!p.section) p.section = sectionFromHeading(p.heading_path);
  const needing = actsToPlace(passages);
  await Promise.all(needing.map(async (name) => {
    try {
      const read = () => actText(supabase, name);
      const doc = clock ? await clock.time("place: act text", read, { act: name }) : await read();
      if (!doc) return;
      for (const p of passages) {
        if (p.act_name !== name || p.section) continue;
        const at = doc.text.indexOf(norm(p.anchorText ?? p.text.slice(0, 200)));
        if (at >= 0) p.section = sectionAt(doc.index, at);
      }
    } catch (err) {
      console.error(`could not place passages of ${name} in sections: ${err.message}`);
    }
  }));
}

// The section a question names, read whole, when the Act it names is known.
async function sectionLead(supabase, query, actNames) {
  const m = SECTION_RE.exec(query);
  if (!m || !parseSection(m[1])) return null;
  let names = actNames ?? [];
  if (!names.length) {
    try { names = (await listActs(supabase)).map((a) => a.act_name); } catch { return null; }
  }
  const act = namedAct(query, names) ?? (actNames?.length === 1 ? actNames[0] : null);
  if (!act) return null;
  try {
    const s = await readActSection(supabase, { act, section: m[1] });
    return {
      key: s.id, documentId: null, scope: "statute", content: s.text, text: s.text, act_name: s.act_name, section: s.section,
      heading_path: s.heading ? `${s.section}. ${s.heading}` : null, url: s.source_url ?? null, lead: true, metadata: { act_name: s.act_name, source_url: s.source_url ?? null },
    };
  } catch {
    return null;
  }
}

/** A finished passage, as every caller receives it. */
function toPassage(c) {
  return {
    id: c.key,
    documentId: c.documentId ?? null,
    scope: c.scope,
    label: c.label,
    text: c.text,
    title: c.title ?? null,
    filename: c.filename ?? c.title ?? null,
    act_name: c.act_name ?? null,
    section: c.section ?? null,
    heading_path: c.heading_path ?? null,
    page: c.page ?? null,
    storage_path: c.storage_path ?? null,
    document_version_id: c.document_version_id ?? null,
    matter_document_id: c.matter_document_id ?? null,
    version_number: c.version_number ?? null,
    url: c.url ?? null,
    similarity: typeof c.rerankScore === "number" ? c.rerankScore : typeof c.rrf === "number" ? Math.round(c.rrf * 1e6) / 1e6 : null,
    rerankScore: typeof c.rerankScore === "number" ? c.rerankScore : null,
    rrf: c.rrf ?? null,
    vectorRank: c.vectorRank ?? null,
    keywordRank: c.keywordRank ?? null,
    nameRank: c.nameRank ?? null,
    lead: !!c.lead,
    metadata: c.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Timing

const LATE = Symbol("late");

// p's value, or LATE when it has not settled within `ms`.
function within(p, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms), LATE); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * When each stage of one search started and how long it took, in
 * milliseconds from the start: events [{ stage, start, ms, ...detail }].
 */
export function stopwatch(now = () => performance.now()) {
  const t0 = now();
  const events = [];
  const add = (stage, started, detail, error) => {
    const e = { stage, start: Math.round(started - t0), ms: Math.round(now() - started), ...detail };
    if (error) e.error = String(error?.message ?? error).slice(0, 200);
    events.push(e);
  };
  return {
    events,
    elapsed: () => Math.round(now() - t0),
    /** Runs fn and records it with `detail`, and `after(result)` when it succeeds. */
    async time(stage, fn, detail = {}, after = null) {
      const started = now();
      let result;
      try {
        result = await fn();
      } catch (err) {
        add(stage, started, detail, err);
        throw err;
      }
      add(stage, started, after ? { ...detail, ...after(result) } : detail);
      return result;
    },
    timeSync(stage, fn, detail = {}) {
      const started = now();
      try {
        return fn();
      } finally {
        add(stage, started, detail);
      }
    },
    note(stage, detail = {}) {
      events.push({ stage, start: Math.round(now() - t0), ms: 0, ...detail });
    },
  };
}

// A promise's outcome, readable without waiting for it.
function track(p) {
  const t = { p, state: "pending", value: undefined, error: undefined };
  p.then((v) => { t.state = "ok"; t.value = v; }, (e) => { t.state = "error"; t.error = e; });
  return t;
}

// ---------------------------------------------------------------------------
// The search

// Double or curly quotes around at least a few characters: exact words.
const QUOTED_RE = /["“”][^"“”]{3,}["“”]/;

/**
 * Whether a question gains from the model's phrasings: not when it names a
 * section ("s.74", "rule 36"), quotes the exact words it wants, or is under
 * four words — those are searched as asked.
 */
export function rewriteWorthwhile(query) {
  const q = norm(query);
  if (SECTION_RE.test(q) || QUOTED_RE.test(q)) return false;
  return q.split(" ").filter(Boolean).length >= 4;
}

// One search's work, started at once: `full` (the whole search, a promise of
// its result) and, with `wordsFirst`, a search by words alone beside it;
// fallback() returns the best result in hand when `full` is late or has
// failed. `work` stops this search's own calls (the reranker, the database
// searches); the embedding and the rewrite, which other searches may be
// sharing through the caches, stop only with `signal`.
function startSearch({
  supabase, voyageKey, anthropicJson = null, query, scope,
  matterId = null, actNames = null, documentTypeId = null, allVersions = false,
  excludeDocumentId = null, excludeStoragePath = null,
  k = 8, rewrite = true, rerank = true, minScore = 0, candidates = CANDIDATES,
  rewriteWaitMs = REWRITE_WAIT_MS, rerankPool = RERANK_POOL, rerankChars = RERANK_CHARS, timings = false,
  deadlineMs = 0, wordsFirst = false, signal = null, work, fetchImpl = globalThis.fetch,
}) {
  const clock = stopwatch();
  const q = norm(query);
  const meter = { voyageCalls: 0 };
  const voyage = (url, init) => { meter.voyageCalls++; return fetchImpl(url, init); };
  // path: which search produced the passages — "full", "fused" (the
  // question's own search_passages call, not reranked), "words" (by words
  // alone, not reranked) or "none" (nothing was back).
  const blank = () => ({ passages: [], phrasings: [q], engine: null, reranked: false, rerankSkipped: null, rewriteLate: false, fellBack: false, reason: null, path: null, voyageCalls: 0 });
  const finish = (out) => {
    out.voyageCalls = meter.voyageCalls;
    if (timings) {
      out.timings = {
        total: clock.elapsed(), scope, engine: out.engine, phrasings: out.phrasings.length, rewriteLate: out.rewriteLate, reranked: out.reranked,
        rerankSkipped: out.rerankSkipped, voyageCalls: meter.voyageCalls, fellBack: out.fellBack, reason: out.reason, path: out.path,
        deadlineMs: deadlineMs > 0 ? deadlineMs : null,
        events: [...clock.events].sort((a, b) => a.start - b.start),
      };
    }
    return out;
  };
  if (q.length < 2 || (scope === "project" && !matterId)) {
    const out = finish({ ...blank(), path: "full" });
    return { clock, full: Promise.resolve(out), fallback: async () => out };
  }

  const named = (actNames ?? []).filter(Boolean);
  const question = q.length <= MAX_QUESTION_CHARS;
  const sectionAsked = scope === "statute" && question && SECTION_RE.test(q);
  const rewriting = !!(rewrite && anthropicJson && question && (scope === "precedent" || scope === "statute") && rewriteWorthwhile(q));

  // A promise started now and maybe awaited later: its failure is handled
  // where it is awaited, never left unhandled if the search stops first.
  const started = (p) => { p.catch(noop); return p; };
  // What the quick way needs to see of the full search.
  const st = { done: false, qEmb: null, plain: null, plainByWords: false, words: null, versionsP: null };

  // Everything that needs only the question starts at once: the rewrite,
  // the named Acts' other copies, the section the question names, and —
  // when there is no rewrite to wait for, or it is already kept — the
  // question's embedding.
  const rewriteP = rewriting
    ? started(clock.time("rewrite", () => rewriteQuery({ anthropicJson, query: q, scope, signal }), {}, (r) => ({ phrasings: r.length })))
    : null;
  const embed = (texts) => clock.time("embed", () => embedQueries(voyageKey, texts, { fetchImpl: voyage, signal }), { texts: texts.length }, (r) => ({ sent: r.sent }))
    .then((r) => r.vectors)
    .catch((err) => {
      if (signal?.aborted) throw err;
      console.error(`query embedding failed, searching by words only: ${err.message}`);
      return null;
    });
  const actsP = started(scope === "statute" && named.length
    ? clock.time("acts", () => expandActs(supabase, named), {}, (a) => ({ acts: a.length }))
    : Promise.resolve([]));
  const actsT = track(actsP);
  const leadP = sectionAsked
    ? started(actsP.then((acts) => clock.time("section lead", () => sectionLead(supabase, q, named.length ? acts : null), {}, (s) => ({ found: !!s }))))
    : null;
  const leadT = leadP ? track(leadP) : null;

  // Meaning only, on match_documents (the current-version filter applied
  // here): before the search_passages migration.
  const byMeaning = async (embedding, acts, terms) => {
    if (!st.versionsP) st.versionsP = scope === "project" ? started(projectVersions(supabase, matterId)) : Promise.resolve(null);
    const list = await vectorFallback(supabase, {
      scope, embedding, matterId, actNames: acts, documentTypeId, allVersions, excludeDocumentId, candidates,
      terms, versions: await st.versionsP, signal: work,
    });
    list.engine = "vector";
    return list;
  };
  // One phrasing searched: search_passages, or match_documents before that
  // migration. The list carries the engine that answered.
  const searchOne = async (i, phrase, embedding, acts, terms) => {
    if (Date.now() >= hybridMissingUntil) {
      try {
        const list = await hybridSearch(supabase, {
          query_text: i === 0 ? keywordText(phrase) : phrase,
          query_embedding: embedding ?? null,
          scope,
          matter_id: scope === "project" ? matterId : null,
          act_names: scope === "statute" && acts.length ? acts : null,
          document_type_id: documentTypeId ?? null,
          all_versions: !!allVersions,
          exclude_document_id: excludeDocumentId ?? null,
          k: candidates,
        }, work);
        list.engine = "hybrid";
        return list;
      } catch (err) {
        if (!isMissingFunction(err)) throw err;
        hybridMissingUntil = Date.now() + MISSING_RETRY_MS;
        console.warn(`search_passages is not in the database yet (${err.dbMessage ?? err.message}); searching with match_documents`);
      }
    }
    if (!embedding) {
      if (i === 0) throw new Error("The search service did not respond, so the library could not be searched.");
      return [];
    }
    return byMeaning(embedding, acts, terms);
  };
  const search = (i, phrase, embedding, acts, terms, stage = "search") =>
    clock.time(stage, () => searchOne(i, phrase, embedding, acts, terms), { phrasing: i, byWordsOnly: !embedding }, (rows) => ({ rows: rows.length, engine: rows.engine }));

  // The question as asked, searched as soon as its embedding is in hand (by
  // its words alone when the embedding failed).
  let qEmbP = null;
  let plainP = null;
  const startPlain = (embP, terms) => {
    qEmbP = embP;
    st.qEmb = track(embP);
    plainP = started(Promise.all([embP, actsP]).then(([emb, acts]) => {
      work.throwIfAborted();
      st.plainByWords = !emb;
      return search(0, q, emb, acts, terms);
    }));
    st.plain = track(plainP);
  };
  if (!rewriting || (voyageKey && recall(embedCache, embedKey(q)) !== undefined)) {
    startPlain(started(embed([q]).then((v) => v?.[0] ?? null)), queryTerms(q, []));
  }

  // Under a deadline, the question searched by its words alone from the
  // start — search_passages with no embedding: its keyword leg (precedent
  // paragraphs, statute rows, the project's current versions) and file-name
  // leg, no Voyage call — so that something is in hand whatever the
  // embedding does. Only the quick way reads it; its failure is seen there.
  if (wordsFirst) {
    st.words = track(started(actsP.then((acts) => {
      work.throwIfAborted();
      return search(0, q, null, acts, queryTerms(q, []), "words only");
    })));
  }

  // Merged, without repeats, at most three a file (any number from one Act
  // when the search was confined to named Acts).
  const merge = (lists, acts) => {
    let pool = fuseLists(lists);
    if (excludeStoragePath) pool = pool.filter((c) => c.storage_path !== excludeStoragePath);
    pool = dedupeByText(pool);
    return capPerFile(pool, scope === "statute" && acts.length ? Infinity : FILE_CAP);
  };
  // Each passage's window (what the model reads of it), section and label.
  const dress = (pool, windowQueries) => clock.timeSync("windows and labels", () => {
    for (const c of pool) {
      Object.assign(c, passageText(c.content, windowQueries));
      if (scope === "statute") c.section = sectionFromHeading(c.heading_path);
      c.label = buildLabel(c);
    }
  }, { passages: pool.length });
  const withLead = (final, lead) => (lead ? [lead, ...final.filter((p) => !(p.act_name === lead.act_name && p.section === lead.section))].slice(0, k) : final);

  const full = started((async () => {
    const out = blank();
    let phrasings = [];
    if (rewriteP) {
      const got = await within(rewriteP, rewriteWaitMs - clock.elapsed());
      work.throwIfAborted();
      if (got === LATE) {
        out.rewriteLate = true;
        clock.note("rewrite not waited for", { waitMs: rewriteWaitMs });
      } else {
        phrasings = got;
      }
    }
    out.phrasings = [q, ...phrasings].slice(0, 4);
    const extra = out.phrasings.slice(1);
    const terms = queryTerms(q, extra);
    // One embedding call: the question with its phrasings, or the
    // phrasings alone when the question's embedding was kept.
    let extraEmbP = Promise.resolve([]);
    if (!qEmbP) {
      const allP = started(embed([q, ...extra]));
      startPlain(started(allP.then((v) => v?.[0] ?? null)), terms);
      extraEmbP = allP.then((v) => (v ? v.slice(1) : null));
    } else if (extra.length) {
      extraEmbP = embed(extra);
    }
    const acts = await actsP;
    const extraP = started(extraEmbP.then((embs) => {
      work.throwIfAborted();
      return Promise.all(extra.map((p, j) => search(j + 1, p, embs?.[j] ?? null, acts, terms)));
    }));
    const lists = [await plainP, ...(await extraP)];
    work.throwIfAborted();
    out.engine = lists.some((l) => l.engine === "vector") ? "vector" : lists.some((l) => l.engine === "hybrid") ? "hybrid" : null;

    const merged = merge(lists, acts);
    const pool = merged.slice(0, Math.max(rerankPool, k));
    const windowQueries = [question ? q : keywordText(q), ...extra];
    dress(pool, windowQueries);

    // The Acts the best passages come from are read while the reranker works
    // (placeSections then finds them read or being read).
    if (scope === "statute") {
      for (const name of actsToPlace(pool, PLACE_ACTS + 1)) {
        started(clock.time("prefetch: act text", () => actText(supabase, name), { act: name }));
      }
    }

    // The reranker only where it can change what is returned, and not for a
    // small project search, where the fused order serves.
    let final = pool.slice(0, k);
    if (!rerank) out.rerankSkipped = "not asked for";
    else if (merged.length <= k) out.rerankSkipped = `${merged.length} passages for ${k} places`;
    else if (scope === "project" && merged.length <= 2 * k) out.rerankSkipped = `a project search with ${merged.length} passages, at most twice ${k}`;
    if (out.rerankSkipped) {
      if (rerank) clock.note("rerank skipped", { reason: out.rerankSkipped });
    } else {
      const chars = pool.reduce((n, c) => n + Math.min(String(c.text ?? "").length, rerankChars > 0 ? rerankChars : Infinity), 0);
      const r = await clock.time("rerank", () => rerankPassages({ voyageKey, query: q, passages: pool, k, maxChars: rerankChars, queries: windowQueries, fetchImpl: voyage, signal: work }),
        { docs: pool.length, chars }, (x) => ({ reranked: x.reranked }));
      work.throwIfAborted();
      final = r.passages;
      out.reranked = r.reranked;
      // A floor on the reranker's score, for callers that would rather have
      // nothing than a weak passage (review evidence). Unreranked passages
      // have no comparable score and are kept.
      if (r.reranked && minScore > 0) final = final.filter((c) => c.rerankScore >= minScore);
    }

    if (scope === "statute") {
      await clock.time("place", () => placeSections(supabase, final, clock), { acts: actsToPlace(final).length });
      work.throwIfAborted();
      if (leadP) final = withLead(final, await leadP);
    }
    for (const c of final) c.label = buildLabel(c);
    out.passages = final.map(toPassage);
    out.path = "full";
    st.done = true;
    return finish(out);
  })());
  const fullT = track(full);

  // The best result in hand at the deadline (or when the full search has
  // failed: `failure`): the full search when it is done; else the question's
  // own search_passages result, not reranked; else the words-only result.
  // When none is back, the first to answer within the grace; then nothing —
  // or, when the full search failed and nothing else can answer, its error.
  // The passages are built from copies: nothing the full search does after
  // this changes them, and the reranker is never run here.
  const fallback = async (deadlineMs, failure = null) => {
    const ways = [
      [fullT, "full", null],
      [st.plain, st.plainByWords ? "words" : "fused", st.plainByWords
        ? "returned the question's own search, by words alone (its embedding failed), not reranked"
        : "returned the question's own search (words and meaning fused), not reranked"],
      [st.words, "words", "returned the search by words alone (the question's embedding was not back), not reranked"],
    ];
    const pick = () => ways.find(([t]) => t?.state === "ok");
    let chosen = pick();
    while (!chosen) {
      const pending = ways.map(([t]) => t).filter((t) => t?.state === "pending");
      const left = deadlineMs + FALLBACK_GRACE_MS - clock.elapsed();
      if (!pending.length || left <= 0) break;
      await within(Promise.race(pending.map((t) => t.p.then(noop, noop))), left);
      chosen = pick();
    }
    if (chosen?.[1] === "full") return chosen[0].value;
    const why = failure ? `the search failed (${String(failure?.message ?? failure).slice(0, 200)})` : `the search took longer than ${deadlineMs} ms`;
    const out = blank();
    out.fellBack = true;
    if (!chosen) {
      if (failure && !ways.some(([t]) => t?.state === "pending")) throw failure;
      out.path = "none";
      out.reason = `${why} and neither the question's own search nor the search by words was back in time; nothing returned`;
      clock.note("fell back", { reason: out.reason, path: out.path });
      console.error(`retrieve (${scope}): ${out.reason}`);
      return finish(out);
    }
    const [t, path, how] = chosen;
    out.path = path;
    out.reason = `${why}: ${how}`;
    out.engine = t.value.engine ?? null;
    const acts = actsT.state === "ok" ? actsT.value : [];
    const pool = merge([t.value], acts).slice(0, k);
    dress(pool, [question ? q : keywordText(q)]);
    const final = scope === "statute" && leadT?.state === "ok" ? withLead(pool, leadT.value) : pool;
    for (const c of final) c.label = buildLabel(c);
    out.passages = final.map(toPassage);
    clock.note("fell back", { reason: out.reason, path: out.path });
    console.warn(`retrieve (${scope}): ${out.reason}`);
    return finish(out);
  };

  return { clock, full, fallback };
}

/**
 * The search, with what it did: { passages, phrasings, engine: "hybrid" |
 * "vector" | null, reranked, rerankSkipped, rewriteLate, fellBack, reason,
 * path, voyageCalls } and, with `timings: true`, timings: { total, events:
 * [{ stage, start, ms, ... }], ... }. See retrieve().
 */
export async function retrieveDetailed(options) {
  const scope = options?.scope;
  if (!SCOPES.has(scope)) throw new Error(`retrieve: scope must be project, precedent or statute, not ${scope}`);
  const raw = options.deadlineMs ?? RETRIEVE_DEADLINE_MS;
  const deadlineMs = raw > 0 && Number.isFinite(raw) ? raw : 0;
  const signal = options.signal ?? null;
  // Stops this search's own calls when the caller goes, when it falls back,
  // and once it has returned (the words-only search started beside it, say).
  const stop = new AbortController();
  const relay = () => stop.abort(signal.reason);
  if (signal?.aborted) stop.abort(signal.reason);
  else signal?.addEventListener("abort", relay, { once: true });
  try {
    const run = startSearch({ ...options, deadlineMs, wordsFirst: deadlineMs > 0, signal, work: stop.signal });
    if (!deadlineMs) return await run.full;
    let r;
    try {
      r = await within(run.full, deadlineMs - run.clock.elapsed());
    } catch (err) {
      // The full search failed before the deadline: what is in hand, else
      // the error.
      signal?.throwIfAborted();
      return await run.fallback(deadlineMs, err);
    }
    if (r !== LATE) return r;
    signal?.throwIfAborted();
    return await run.fallback(deadlineMs);
  } finally {
    signal?.removeEventListener("abort", relay);
    stop.abort(new Error("the search has returned"));
  }
}

/**
 * Passages for a question from one scope, best first, each with a citation
 * label: [{ id, scope, label, text, title, filename, act_name, section,
 * heading_path, page, storage_path, document_version_id, version_number,
 * url, similarity, ... }]. `similarity` is the rerank score, or the fused
 * score when reranking was not possible or not needed.
 *
 * Options: matterId (project), actNames (statute: only these laws),
 * documentTypeId, allVersions (project: superseded and AI versions too),
 * excludeDocumentId / excludeStoragePath (leave one document out), k,
 * rewrite (model phrasings for precedent and statute questions; needs
 * anthropicJson), rewriteWaitMs (how long they are waited for), rerank,
 * rerankPool / rerankChars (how many passages the reranker reads, and how
 * much of each), minScore (drop reranked passages scoring below),
 * deadlineMs (a hard total: the search returns within this plus
 * FALLBACK_GRACE_MS, the quick way when the full search is not done; 0:
 * never), timings (return { passages, timings } instead: each stage's start
 * and duration, the Voyage calls made, whether and why it fell back, and
 * which path — full, fused, words, none — produced the passages).
 */
export async function retrieve(options) {
  const d = await retrieveDetailed(options);
  return options?.timings ? { passages: d.passages, timings: d.timings } : d.passages;
}
