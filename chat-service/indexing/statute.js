// A law the review's online lookup downloaded, added to the firm's law
// library from the server, under the service role.
//
// The Hub's own route is the ingest-documents edge function
// (supabase/functions/ingest-documents/index.ts), called with the signed-in
// lawyer's token: it splits the text into 1,000-word passages overlapping by
// 200, embeds each with voyage-law-2 as a "document", and inserts one
// `documents` row per passage (is_statute true, the metadata plus
// chunk_index and chunk_total, created_by the lawyer). The claude.ai
// connector keeps no such token (it signs the lawyer out once membership is
// checked), so a review started from claude.ai could not add what its
// lookup found. This is the same ingest, run here: the edge function's
// splitter ported line for line, the index worker's embedder (embed.js:
// the same model and input type, with the retries the Voyage free tier
// needs; the vectors do not depend on how the passages are batched), and
// the same row, column for column. The edge function and the Law Library
// tab are untouched, so who can add a law from the Hub is unchanged; here
// the lawyer must be an approved member (is_firm_member, the same gate the
// table's own policy applies to the edge function's insert). Node 20.

import { embedDocuments } from "./embed.js";

/** The edge function's defaults (ingest-documents: chunkSize 1000, chunkOverlap 200, in words). */
export const STATUTE_CHUNK_WORDS = 1000;
export const STATUTE_CHUNK_OVERLAP = 200;
/** Rows inserted per request; the edge function inserts them one by one, to the same effect. */
const INSERT_BATCH = 50;

/** The edge function's splitIntoChunks, unchanged: whitespace-separated words, a window of `size` moving by size - overlap. */
export function splitIntoChunks(text, size = STATUTE_CHUNK_WORDS, overlap = STATUTE_CHUNK_OVERLAP) {
  const words = String(text).split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += size - overlap) {
    const chunk = words.slice(i, i + size).join(" ");
    if (chunk.trim()) chunks.push(chunk);
  }
  return chunks.length > 0 ? chunks : [String(text)];
}

/**
 * The rows the edge function would insert for this law, without embeddings
 * (the caller adds them): content, metadata with chunk_index and
 * chunk_total, no project or document type, a statute and not a precedent,
 * created by the lawyer.
 */
export function statuteRows(content, metadata, userId) {
  const chunks = splitIntoChunks(content);
  return chunks.map((chunk, index) => ({
    content: chunk,
    metadata: { ...(metadata ?? {}), chunk_index: index, chunk_total: chunks.length },
    matter_id: null,
    document_type_id: null,
    is_precedent: false,
    is_statute: true,
    created_by: userId,
  }));
}

/**
 * Adds one law's text to the library as `userId`, the ingest-documents way.
 * Throws with a plain reason; nothing is inserted unless every passage was
 * embedded. Returns { chunks }.
 */
export async function ingestStatute({ supabase, voyageKey, userId, content, metadata, embed = embedDocuments, log = () => {} }) {
  if (!String(content ?? "").trim()) throw new Error("the law's text is empty");
  if (!userId) throw new Error("no lawyer to add the law for");
  const { data: member, error: memberError } = await supabase.rpc("is_firm_member", { _user_id: userId });
  if (memberError) throw new Error(`membership could not be checked: ${memberError.message}`);
  if (member !== true) throw new Error("only an approved member of the firm can add a law to the library");
  const rows = statuteRows(content, metadata, userId);
  const vectors = await embed(rows.map((r) => r.content), { apiKey: voyageKey, log });
  rows.forEach((row, i) => { row.embedding = vectors[i]; });
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { error } = await supabase.from("documents").insert(rows.slice(i, i + INSERT_BATCH));
    if (error) throw new Error(`the passages could not be stored: ${error.message}`);
  }
  log(`statute ingest: ${rows.length} passages of ${metadata?.act_name ?? "a law"} for ${userId}`);
  return { chunks: rows.length };
}
