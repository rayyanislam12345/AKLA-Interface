// Shared semantic-retrieval helper for draft-document, suggest-redline, and
// redline-chat — all three need the same "embed a query string, then pull
// the most similar precedents and the most similar statute excerpts"
// sequence. Callers format the returned rows into their own prompt
// sections (styles differ — e.g. draft-document relabels precedent as
// "supplementary" once a standard template exists), so this only owns the
// embedding + retrieval, not final prompt text.

export interface GroundedMatch {
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface GroundedContext {
  precedents: GroundedMatch[];
  statutes: GroundedMatch[];
  matterDocuments: GroundedMatch[];
}

export async function fetchGroundedContext(
  supabase: any,
  voyageKey: string,
  queryText: string,
  documentTypeId: string | null,
  matterId: string | null = null,
  precedentCount = 5,
  statuteCount = 3,
  // Used by suggest-redline's cross-document conflict pass: other documents
  // already on this matter, for checking internal consistency. Off by
  // default since draft-document/redline-chat don't need it.
  includeMatterDocuments = false,
  excludeStoragePath: string | null = null,
  matterDocumentCount = 8
): Promise<GroundedContext> {
  const [embeddingResult, relevantActNames] = await Promise.all([
    fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${voyageKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'voyage-law-2',
        // Voyage's per-input limit is well above any reasonable query string
        // here, but a runaway document's full text (suggest-redline passes
        // the document being reviewed as the query) could exceed it — trim
        // to a safe size; the first few thousand characters carry plenty of
        // signal for retrieval purposes.
        input: [queryText.slice(0, 8000)],
        input_type: 'query',
      }),
    }),
    // A matter's curated Relevant Laws list, if it has one — scopes statute
    // retrieval to just those Acts instead of the whole library. A matter
    // with nothing attached yet (new, or before auto-detection has run)
    // falls back to the unrestricted search below.
    matterId
      ? supabase.from('matter_relevant_laws').select('act_name').eq('matter_id', matterId).eq('status', 'available')
      : Promise.resolve({ data: null }),
  ]);

  if (!embeddingResult.ok) {
    const error = await embeddingResult.text();
    console.error('Error generating retrieval query embedding:', error);
    return { precedents: [], statutes: [], matterDocuments: [] };
  }

  const embeddingData = await embeddingResult.json();
  const queryEmbedding = embeddingData.data[0].embedding;

  const relevantActList = relevantActNames.data as { act_name: string }[] | null;
  const filterActNames = relevantActList && relevantActList.length > 0
    ? relevantActList.map((r) => r.act_name)
    : null;

  const [{ data: precedentMatches, error: precedentError }, { data: statuteMatches, error: statuteError }, matterDocumentMatches] = await Promise.all([
    supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_count: precedentCount,
      filter_document_type_id: documentTypeId,
      precedent_only: true,
    }),
    supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_count: statuteCount,
      statute_only: true,
      filter_act_names: filterActNames,
    }),
    includeMatterDocuments && matterId
      ? supabase.rpc('match_documents', {
          query_embedding: queryEmbedding,
          // One extra to absorb the document being reviewed's own chunk,
          // which is filtered out below by storage_path.
          match_count: matterDocumentCount + 1,
          filter_matter_id: matterId,
        })
      : Promise.resolve({ data: [] as GroundedMatch[], error: null }),
  ]);

  if (precedentError) console.error('Error matching precedents:', precedentError);
  if (statuteError) console.error('Error matching statutes:', statuteError);
  if (matterDocumentMatches.error) console.error('Error matching matter documents:', matterDocumentMatches.error);

  const matterDocuments = ((matterDocumentMatches.data ?? []) as GroundedMatch[])
    .filter((m) => !excludeStoragePath || (m.metadata as any)?.storage_path !== excludeStoragePath)
    .slice(0, matterDocumentCount);

  return {
    precedents: precedentMatches ?? [],
    statutes: statuteMatches ?? [],
    matterDocuments,
  };
}
