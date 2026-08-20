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

    // Voyage AI batches embeddings in a single call (up to 128 inputs per request)
    const embeddings: number[][] = [];
    const BATCH_SIZE = 128;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
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
        embeddings[item.index] = item.embedding;
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
