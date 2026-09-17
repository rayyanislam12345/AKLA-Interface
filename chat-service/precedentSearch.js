// Searching the precedent library for clauses.
//
// "Find every liquidated damages clause we have drafted" is a question about
// passages, not files. The library's rows are whole documents or large
// chunks of them (a precedent averages 83,000 characters a row), so a search
// that returned rows would hand the associate forty pages to read. Instead:
// the rows most like the question are found by embedding, each is cut into
// its paragraphs, the paragraphs that could answer are embedded in turn and
// ranked against the question, and the best few per agreement are returned
// with the file they came from — so the viewer can open the agreement at
// that clause.

const MAX_FILES = 15;
const MAX_ROWS = 40;
const EXCERPTS_PER_FILE = 3;
const PARAGRAPHS_PER_ROW = 48;
const MAX_PARAGRAPHS = 260;
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
  const found = terms.filter((t) => lower.includes(t));
  return { count: found.length, found };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

async function embed(voyageKey, inputs, inputType, signal) {
  const out = [];
  for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${voyageKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "voyage-law-2", input: inputs.slice(i, i + EMBED_BATCH), input_type: inputType }),
      signal,
    });
    if (!resp.ok) throw new Error(`Embedding failed (${resp.status})`);
    const data = await resp.json();
    for (const row of data.data) out.push(row.embedding);
  }
  return out;
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
      system: "You expand a search over a Pakistani law firm's precedent agreements. Reply with ONLY a JSON array of up to 8 short lower-case phrases (2-4 words each) that a drafter would use for the same concept as the query, including the expansion of any abbreviation. No commentary.",
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

  const { data: rows, error } = await supabase.rpc("match_documents", {
    query_embedding: queryEmbedding, match_threshold: 0.2, match_count: MAX_ROWS, precedent_only: true,
    ...(documentTypeId ? { filter_document_type_id: documentTypeId } : {}),
  });
  if (error) throw new Error(`Library search failed: ${error.message}`);
  if (!rows?.length) return { query: q, terms, results: [] };

  // Every paragraph that mentions a term is a candidate; the rest of a row
  // is sampled evenly so a clause worded differently can still be found.
  const candidates = [];
  for (const row of rows) {
    const paragraphs = paragraphsOf(row.content).map((p, index) => ({ ...p, index, row, hits: termHits(p.text, terms) }));
    const hit = paragraphs.filter((p) => p.hits.count > 0);
    const rest = paragraphs.filter((p) => p.hits.count === 0);
    const room = Math.max(0, PARAGRAPHS_PER_ROW - hit.length);
    const step = Math.max(1, Math.ceil(rest.length / Math.max(1, room)));
    candidates.push(...hit.slice(0, PARAGRAPHS_PER_ROW), ...rest.filter((_, i) => i % step === 0).slice(0, room));
  }
  const pool = candidates
    .sort((a, b) => b.hits.count - a.hits.count || b.row.similarity - a.row.similarity)
    .slice(0, MAX_PARAGRAPHS);
  const vectors = await embed(voyageKey, pool.map((p) => p.text), "document", signal);
  pool.forEach((p, i) => { p.score = cosine(queryEmbedding, vectors[i]) + Math.min(p.hits.count, 3) * 0.06; });

  const byFile = new Map();
  for (const p of pool) {
    const key = p.row.metadata?.storage_path ?? p.row.id;
    const file = byFile.get(key) ?? { storagePath: p.row.metadata?.storage_path ?? null, filename: p.row.metadata?.filename ?? "Untitled", documentTypeId: p.row.document_type_id ?? null, excerpts: [] };
    file.excerpts.push({ text: p.text, score: p.score, terms: p.hits.found, chunkIndex: p.row.metadata?.chunk_index ?? null, offset: p.offset });
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
