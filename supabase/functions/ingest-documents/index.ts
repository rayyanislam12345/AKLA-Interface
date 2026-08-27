import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      content,
      metadata = {},
      chunkSize = 1000,
      chunkOverlap = 200,
      matterId = null,
      documentTypeId = null,
      isPrecedent = false,
      isStatute = false,
    } = await req.json();

    if (!content) {
      return new Response(JSON.stringify({ error: 'Content is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Authorization header required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const voyageKey = Deno.env.get('VOYAGE_API_KEY');

    if (!voyageKey) {
      return new Response(JSON.stringify({ error: 'Voyage API key not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    // Get user from auth
    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Split content into chunks
    const chunks = splitIntoChunks(content, chunkSize, chunkOverlap);
    console.log(`Split content into ${chunks.length} chunks`);

    // Voyage AI batches embeddings in a single call, but the real limit
    // (confirmed the hard way ingesting a 198-chunk statute) is 120,000
    // tokens per batch, not a fixed chunk count — 128 chunks comfortably
    // fits that for a typical-length document, but not for a chunk size
    // this ingest call is using with content this dense. Batch by an
    // estimated token budget instead. 4 chars/token is the usual English
    // heuristic, but dense numeric/tabular text (e.g. the Income Tax
    // Ordinance) tokenizes worse — a real batch estimated at 100,000
    // tokens under that heuristic came back from Voyage at 123,267,
    // still over the 120,000 limit. Use 3 chars/token and a lower budget
    // for real margin against that kind of content.
    const MAX_BATCH_TOKENS = 80_000;
    const CHARS_PER_TOKEN = 3;
    const batches: string[][] = [];
    let currentBatch: string[] = [];
    let currentBatchChars = 0;
    for (const chunk of chunks) {
      const chunkChars = chunk.length;
      if (currentBatch.length > 0 && currentBatchChars + chunkChars > MAX_BATCH_TOKENS * CHARS_PER_TOKEN) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchChars = 0;
      }
      currentBatch.push(chunk);
      currentBatchChars += chunkChars;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    const embeddings: number[][] = [];
    let chunkOffset = 0;
    for (const batch of batches) {
      const batchStartIndex = chunkOffset;
      chunkOffset += batch.length;
      const embeddingResponse = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${voyageKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'voyage-law-2',
          input: batch,
          input_type: 'document',
        }),
      });

      if (!embeddingResponse.ok) {
        const error = await embeddingResponse.text();
        console.error('Error generating embeddings batch:', error);
        throw new Error(`Failed to generate embeddings: ${error}`);
      }

      const embeddingData = await embeddingResponse.json();
      for (const item of embeddingData.data) {
        // item.index is relative to THIS batch, not the full chunk list —
        // confirmed the hard way that any document needing more than one
        // batch was silently corrupting/dropping embeddings past the
        // first, since every batch's local indices collided at 0..N.
        embeddings[batchStartIndex + item.index] = item.embedding;
      }
    }

    const documents = chunks.map((chunk, index) => ({
      content: chunk,
      embedding: embeddings[index],
      metadata: {
        ...metadata,
        chunk_index: index,
        chunk_total: chunks.length,
      },
    }));

    // Insert documents with embeddings into database
    const insertPromises = documents.map(doc =>
      supabase.from('documents').insert({
        content: doc.content,
        metadata: doc.metadata,
        embedding: doc.embedding,
        matter_id: matterId,
        document_type_id: documentTypeId,
        is_precedent: isPrecedent,
        is_statute: isStatute,
        created_by: user.id,
      })
    );

    const results = await Promise.all(insertPromises);

    const errors = results.filter(r => r.error);
    if (errors.length > 0) {
      console.error('Errors inserting documents:', errors);
      return new Response(JSON.stringify({
        error: 'Failed to insert some documents',
        details: errors,
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      chunks_created: documents.length,
      message: `Successfully ingested ${documents.length} document chunks`,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in ingest-documents:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function splitIntoChunks(text: string, chunkSize: number, overlap: number): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];

  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const chunk = words.slice(i, i + chunkSize).join(' ');
    if (chunk.trim()) {
      chunks.push(chunk);
    }
  }

  return chunks.length > 0 ? chunks : [text];
}
