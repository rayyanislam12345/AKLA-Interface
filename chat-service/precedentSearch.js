// Searching the precedent library for clauses.
//
// "Find every liquidated damages clause we have drafted" is a question about
// passages, not files. Two nets are cast: the precedent_passages index
// (every precedent paragraph, full-text indexed) for the phrases a drafter
// would use — the query and what it stands for — and the embedding index
// for agreements that say the same thing in other words. The paragraphs
// caught are embedded and ranked against the question, and the best few
// per agreement are returned with the file they came from, so the viewer
// can open the agreement at that clause.

const MAX_FILES = 20;
const MAX_ROWS = 12;
const EXCERPTS_PER_FILE = 3;
const KEYWORD_HITS = 600;
const KEYWORD_PER_FILE = 10;
const PARAGRAPHS_PER_ROW = 12;
const MAX_PARAGRAPHS = 320;
const MIN_PARAGRAPH = 40;
const MAX_PARAGRAPH = 2500;
const EMBED_BATCH = 64;

const STOP = new Set("the a an of and or to in for on by with that this these those is are be as at from any all shall may will clause clauses agreement agreements find show examples example past our we".split(" "));

/** The words worth matching in a question, lower-cased, stems left alone. */
export function queryTerms(query, extra = []) {
  const words = [...String(query ?? "").toLowerCase().matchAll(/[a-z][a-z0-9-]{1,}/g)].map((m) => m[0]).filter((w) => !STOP.has(w) && w.length > 1);
  const phrases = extra.map((p) => String(p).toLowerCase().trim()).filter(Boolean);
  return [...new Set([...words, ...phrases])];
}

/** A document's paragraphs, tags gone, in order, each with its offset in the plain text. */
export function paragraphsOf(content) {
  const html = String(content ?? "");
  const plain = html
    .replace(/<\/(?:p|li|h[1-6]|tr|div|td)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
  const out = [];
  let offset = 0;
  for (const raw of plain.split(/\n+/)) {
    const text = raw.replace(/[ \t]+/g, " ").trim();
    if (text.length >= MIN_PARAGRAPH) out.push({ text: text.length > MAX_PARAGRAPH ? text.slice(0, MAX_PARAGRAPH) : text, offset });
    offset += raw.length + 1;
  }
  return out;
}

/** How many of the terms a paragraph contains, and which. */
export function termHits(text, terms) {
  const lower = text.toLowerCase();
  // Whole words only: "ld" is not a hit inside "should".
  const found = terms.filter((t) => new RegExp(`(?:^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(lower));
  return { count: found.length, found };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

async function embed(voyageKey, inputs, inputType, signal) {
  const batches = [];
  for (let i = 0; i < inputs.length; i += EMBED_BATCH) batches.push(inputs.slice(i, i + EMBED_BATCH));
  const results = await Promise.all(batches.map(async (input) => {
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${voyageKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "voyage-law-2", input, input_type: inputType }),
      signal,
    });
    if (!resp.ok) throw new Error(`Embedding failed (${resp.status})`);
    return (await resp.json()).data.map((row) => row.embedding);
  }));
  return results.flat();
}

// The phrases a lawyer would use for the same thing — "LD" is "liquidated
// damages", "delay damages" — so keyword hits are not missed for want of
// the exact words. A model answers in one short JSON array; when it does
// not, the search runs on the question's own words.
async function synonymsFor(query, anthropicJson, signal) {
  if (!anthropicJson) return [];
  try {
    const result = await anthropicJson({
      model: process.env.RESEARCH_MODEL ?? "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: "You expand a search over a Pakistani law firm's precedent agreements (concession, EPC, PPA/EPA, financing, shareholder and track access agreements). Reply with ONLY a JSON array of up to 8 short lower-case phrases (1-4 words each) that a drafter would write in the clause itself for the same concept as the query. Expand abbreviations the way project and construction contracts use them — LD/LDs = liquidated damages, FM = force majeure, CP = conditions precedent, COD = commercial operations date, EoT = extension of time, DSCR = debt service coverage ratio, PPA = power purchase agreement — and never offer an expansion from another field. Include the expanded term itself first. No commentary.",
      messages: [{ role: "user", content: String(query).slice(0, 300) }],
    }, signal);
    const text = (result.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const parsed = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export async function searchPrecedents({ supabase, voyageKey, anthropicJson, query, documentTypeId = null, signal }) {
  const q = String(query ?? "").trim();
  if (q.length < 2) throw new Error("Type what you are looking for, e.g. liquidated damages.");
  const [synonyms, [queryEmbedding]] = await Promise.all([synonymsFor(q, anthropicJson, signal), embed(voyageKey, [q], "query", signal)]);
  const terms = queryTerms(q, synonyms);

  // The phrases the index is searched for: the question as typed (unless it
  // is only a bare abbreviation, which would match any stray "LD") and what
  // it stands for.
  const bare = /^[a-z]{1,4}s?$/i.test(q.replace(/\b(?:clauses?|provisions?|examples?|all|find|show|past|our)\b/gi, "").trim());
  const phrases = [...new Set([...(bare ? [] : [q]), ...synonyms])].slice(0, 10);
  const [keyword, semantic] = await Promise.all([
    phrases.length
      ? supabase.rpc("search_precedent_passages", { p_phrases: phrases, p_document_type_id: documentTypeId, p_limit: KEYWORD_HITS })
      : Promise.resolve({ data: [] }),
    supabase.rpc("match_documents", {
      query_embedding: queryEmbedding, match_threshold: 0.2, match_count: MAX_ROWS, precedent_only: true,
      ...(documentTypeId ? { filter_document_type_id: documentTypeId } : {}),
    }),
  ]);
  if (keyword.error) throw new Error(`Clause search failed: ${keyword.error.message}`);
  if (semantic.error) throw new Error(`Library search failed: ${semantic.error.message}`);

  // Keyword hits, the best few per agreement so one long contract cannot
  // fill the page; then, from the agreements closest in meaning, their
  // paragraphs that mention a term, or a spread of them if none does.
  const candidates = [];
  const perFile = new Map();
  const seen = new Set();
  for (const row of keyword.data ?? []) {
    const key = row.storage_path ?? row.document_id;
    const n = perFile.get(key) ?? 0;
    if (n >= KEYWORD_PER_FILE || seen.has(row.body)) continue;
    perFile.set(key, n + 1);
    seen.add(row.body);
    candidates.push({ text: row.body, offset: row.ordinal, keywordRank: row.rank, hits: termHits(row.body, terms), source: { storagePath: row.storage_path, filename: row.filename, documentTypeId: row.document_type_id, chunkIndex: row.chunk_index, id: row.document_id } });
  }
  for (const row of semantic.data ?? []) {
    const paragraphs = paragraphsOf(row.content).map((p) => ({ ...p, hits: termHits(p.text, terms) })).filter((p) => !seen.has(p.text));
    const hit = paragraphs.filter((p) => p.hits.count > 0);
    const pick = hit.length ? hit.slice(0, PARAGRAPHS_PER_ROW) : paragraphs.filter((_, i) => i % Math.max(1, Math.ceil(paragraphs.length / PARAGRAPHS_PER_ROW)) === 0).slice(0, PARAGRAPHS_PER_ROW);
    for (const p of pick) {
      seen.add(p.text);
      candidates.push({ ...p, keywordRank: 0, source: { storagePath: row.metadata?.storage_path ?? null, filename: row.metadata?.filename ?? "Untitled", documentTypeId: row.document_type_id ?? null, chunkIndex: row.metadata?.chunk_index ?? null, id: row.id } });
    }
  }
  if (!candidates.length) return { query: q, terms, results: [] };
  const pool = candidates
    .sort((a, b) => b.hits.count - a.hits.count || b.keywordRank - a.keywordRank)
    .slice(0, MAX_PARAGRAPHS);
  const vectors = await embed(voyageKey, pool.map((p) => p.text), "document", signal);
  pool.forEach((p, i) => { p.score = cosine(queryEmbedding, vectors[i]) + Math.min(p.hits.count, 3) * 0.05 + (p.keywordRank > 0 ? 0.05 : 0); });

  const byFile = new Map();
  for (const p of pool) {
    const key = p.source.storagePath ?? p.source.id;
    const file = byFile.get(key) ?? { storagePath: p.source.storagePath ?? null, filename: p.source.filename ?? "Untitled", documentTypeId: p.source.documentTypeId ?? null, excerpts: [] };
    file.excerpts.push({ text: p.text, score: p.score, terms: p.hits.found, chunkIndex: p.source.chunkIndex ?? null, offset: p.offset });
    byFile.set(key, file);
  }
  const typeIds = [...new Set([...byFile.values()].map((f) => f.documentTypeId).filter(Boolean))];
  const { data: types } = typeIds.length ? await supabase.from("document_types").select("id, name").in("id", typeIds) : { data: [] };
  const typeName = new Map((types ?? []).map((t) => [t.id, t.name]));

  const results = [...byFile.values()]
    .map((f) => {
      const excerpts = f.excerpts.sort((a, b) => b.score - a.score).slice(0, EXCERPTS_PER_FILE).sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0) || a.offset - b.offset);
      return { ...f, documentTypeName: typeName.get(f.documentTypeId) ?? null, excerpts, score: Math.max(...excerpts.map((e) => e.score)) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FILES);
  return { query: q, terms, results };
}
