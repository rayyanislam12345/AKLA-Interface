// The per-version card: what the document is, in a few fields the project
// page and retrieval can use without reading the whole file. One Haiku call
// on the opening ~12,000 characters plus the heading outline. The card is a
// nice-to-have: if the call fails the passages are still published, and the
// card keeps the parts the reader knows for certain (tracked changes, pages,
// outline).
import { HttpError, isRetryableStatus, withRetry } from "./embed.js";

export const CARD_MODEL = process.env.INDEX_CARD_MODEL ?? "claude-haiku-4-5-20251001";
const OPENING_CHARS = 12_000;
const MAX_OUTLINE_LINES = 150;

const SYSTEM = `You catalogue documents for a Pakistani law firm's project files.
Read the opening of the document and its heading outline, then answer with ONE JSON object and nothing else:
{
  "summary": "three plain sentences: what the document is, between whom, and what it mainly does",
  "document_kind": "a short name for the kind of document, e.g. Concession Agreement, Legal Opinion, Due Diligence Report, Term Sheet, Board Resolution, Letter",
  "parties": [{"name": "...", "role": "e.g. Agency, Concessionaire, Lender, Client"}],
  "key_dates": [{"date": "as written or YYYY-MM-DD", "what": "what happens on it"}],
  "defined_terms": ["up to 20 of the most important defined terms, as written"],
  "clause_outline": ["the main headings in order, with their numbers, up to 40"],
  "statutes_mentioned": ["Pakistani Acts, Ordinances or Rules named in the text, formal names where possible"],
  "suggested_document_type_id": "the id of the best matching type from the list given, or null if none fits"
}
Use only what the text shows. Use [] or null where the text says nothing. Do not invent parties, dates or terms.`;

/** Builds the user message for the card call. */
export function cardPrompt({ title, fileName, text, outline = [], documentTypes = [], side = null, pageCount = null }) {
  const lines = [];
  lines.push(`Title in the project: ${title || "(none)"}`);
  if (fileName) lines.push(`File name: ${fileName}`);
  if (pageCount) lines.push(`Pages: ${pageCount}`);
  if (side?.headers?.length) lines.push(`Page header: ${side.headers.join(" | ").slice(0, 300)}`);
  if (documentTypes.length) {
    lines.push("", "Document types (id: name):");
    for (const t of documentTypes) lines.push(`${t.id}: ${t.name}${t.category ? ` (${t.category})` : ""}`);
  }
  if (outline.length) {
    lines.push("", "Heading outline:");
    for (const o of outline.slice(0, MAX_OUTLINE_LINES)) lines.push(`${"  ".repeat(Math.max(0, Math.min(4, Math.round(o.depth ?? 0) - 1)))}${o.entry}${o.page ? ` (p. ${o.page})` : ""}`);
    if (outline.length > MAX_OUTLINE_LINES) lines.push(`… ${outline.length - MAX_OUTLINE_LINES} more headings`);
  }
  lines.push("", "Opening of the document:", String(text ?? "").slice(0, OPENING_CHARS));
  return lines.join("\n");
}

const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const strings = (v, maxItems, maxLen) => (Array.isArray(v) ? v.map((x) => str(typeof x === "string" ? x : x?.name ?? x?.term, maxLen)).filter(Boolean).slice(0, maxItems) : []);

/**
 * Parses the model's answer into a card. Tolerates code fences and prose
 * around the object; throws when there is no JSON object at all.
 * suggested_document_type_id survives only if it is one of the ids offered.
 */
export function parseCardJson(raw, { documentTypeIds = [] } = {}) {
  const textOut = String(raw ?? "").replace(/```(?:json)?/gi, "");
  const start = textOut.indexOf("{");
  if (start === -1) throw new Error("The card answer had no JSON object");
  // The first balanced object, respecting strings.
  let depth = 0;
  let inString = false;
  let end = -1;
  for (let i = start; i < textOut.length; i++) {
    const c = textOut[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { end = i; break; }
  }
  if (end === -1) throw new Error("The card answer's JSON object is incomplete");
  const parsed = JSON.parse(textOut.slice(start, end + 1));
  const suggested = str(parsed.suggested_document_type_id, 64);
  return {
    summary: str(parsed.summary, 1200),
    document_kind: str(parsed.document_kind, 120),
    parties: Array.isArray(parsed.parties)
      ? parsed.parties.map((p) => (typeof p === "string" ? { name: str(p, 200), role: null } : { name: str(p?.name, 200), role: str(p?.role, 120) })).filter((p) => p.name).slice(0, 20)
      : [],
    key_dates: Array.isArray(parsed.key_dates)
      ? parsed.key_dates.map((d) => (typeof d === "string" ? { date: str(d, 60), what: null } : { date: str(d?.date, 60), what: str(d?.what, 200) })).filter((d) => d.date).slice(0, 20)
      : [],
    defined_terms: strings(parsed.defined_terms, 20, 120),
    clause_outline: strings(parsed.clause_outline, 40, 160),
    statutes_mentioned: strings(parsed.statutes_mentioned, 20, 200),
    suggested_document_type_id: suggested && documentTypeIds.includes(suggested) ? suggested : null,
  };
}

/**
 * Writes the card. Never throws: on any failure returns the facts the reader
 * already knows plus card_error.
 */
export async function buildCard({ apiKey, fetchImpl = fetch, log = () => {}, title, fileName, text, outline, documentTypes, side, pageCount, facts }) {
  const known = { ...facts, generated_at: new Date().toISOString(), model: CARD_MODEL };
  if (side) {
    known.headers = (side.headers ?? []).slice(0, 5).map((h) => h.slice(0, 300));
    known.footers = (side.footers ?? []).slice(0, 5).map((f) => f.slice(0, 300));
    known.comments = (side.comments ?? []).slice(0, 50).map((c) => ({ author: c.author?.slice(0, 120) ?? "", text: c.text.slice(0, 600) }));
    known.comment_count = side.comments?.length ?? 0;
    known.footnote_count = side.footnotes?.length ?? 0;
  }
  if (!apiKey) return { ...known, card_error: "ANTHROPIC_API_KEY is not set" };
  try {
    const data = await withRetry(async () => {
      let resp;
      try {
        resp = await fetchImpl("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify({
            model: CARD_MODEL,
            // 2,000 cut off the answer for a long proposal with many dates and
            // defined terms (16 Oct); the card is a few hundred words at most.
            max_tokens: 4096,
            temperature: 0,
            system: SYSTEM,
            messages: [{ role: "user", content: cardPrompt({ title, fileName, text, outline, documentTypes, side, pageCount }) }],
          }),
          signal: AbortSignal.timeout(90_000),
        });
      } catch (err) {
        throw new HttpError(`Claude request failed: ${err?.message ?? err}`, { retryable: true });
      }
      if (!resp.ok) {
        const body = (await resp.text().catch(() => "")).slice(0, 300);
        throw new HttpError(`Claude ${resp.status}: ${body}`, { status: resp.status, retryable: isRetryableStatus(resp.status) || resp.status === 529, retryAfter: resp.headers.get("retry-after") });
      }
      return resp.json();
    }, { attempts: 4, onRetry: ({ attempt, delay, error }) => log(`card retry ${attempt} in ${delay}ms: ${error.message}`) });
    if (data?.stop_reason === "refusal") return { ...known, card_error: "The summary model declined this document" };
    if (data?.stop_reason === "max_tokens") log("card answer reached its length limit; keeping what parses");
    const answer = (data?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const card = parseCardJson(answer, { documentTypeIds: (documentTypes ?? []).map((t) => t.id) });
    return { ...card, ...known };
  } catch (err) {
    log(`card failed: ${err?.message ?? err}`);
    return { ...known, card_error: "The summary could not be written this time" };
  }
}
