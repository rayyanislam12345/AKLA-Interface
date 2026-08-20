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
      query,
      // voyage-law-2 cosine similarities run lower than OpenAI's embeddings for
      // genuinely relevant matches (observed ~0.6 on a clean match) — 0.5 is a
      // provisional default, worth re-tuning once there's a larger precedent corpus.
      matchThreshold = 0.5,
      matchCount = 5,
      matterId = null,
      documentTypeId = null,
      precedentOnly = false,
    } = await req.json();

    if (!query) {
      return new Response(JSON.stringify({ error: 'Query is required' }), {
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
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');

    if (!voyageKey) {
      return new Response(JSON.stringify({ error: 'Voyage API key not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!anthropicKey) {
      return new Response(JSON.stringify({ error: 'Anthropic API key not configured' }), {
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

    // Generate embedding for the query
    const embeddingResponse = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${voyageKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'voyage-law-2',
        input: [query],
        input_type: 'query',
      }),
    });

    if (!embeddingResponse.ok) {
      const error = await embeddingResponse.text();
      console.error('Error generating query embedding:', error);
      return new Response(JSON.stringify({ error: 'Failed to generate query embedding' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const embeddingData = await embeddingResponse.json();
    const queryEmbedding = embeddingData.data[0].embedding;

    // Search for matching documents
    const { data: matches, error: matchError } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
      filter_matter_id: matterId,
      filter_document_type_id: documentTypeId,
      precedent_only: precedentOnly,
    });

    if (matchError) {
      console.error('Error matching documents:', matchError);
      return new Response(JSON.stringify({ error: 'Failed to search documents' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Found ${matches?.length || 0} matching documents`);

    // Format context from matched documents
    const context = matches && matches.length > 0
      ? matches.map((doc: any, index: number) =>
          `[Source ${index + 1}] (Similarity: ${(doc.similarity * 100).toFixed(1)}%)\n${doc.content}`
        ).join('\n\n---\n\n')
      : 'No relevant documents found in the knowledge base.';

    const systemPrompt = `You are a legal assistant with access to the firm's document knowledge base (prior matters and precedent agreements). Use the following sources to answer the user's question precisely and conservatively. If the sources don't contain relevant information, say so clearly rather than guessing. Cite sources by number (e.g. "[Source 2]") when you rely on them.

KNOWLEDGE BASE SOURCES:
${context}`;

    // Call Anthropic directly
    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1536,
        system: systemPrompt,
        messages: [{ role: 'user', content: query }],
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const errorText = await aiResponse.text();
      console.error('Anthropic API error:', aiResponse.status, errorText);
      return new Response(JSON.stringify({ error: 'AI provider error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const aiData = await aiResponse.json();
    // Claude can emit a `thinking` block ahead of the `text` block (extended
    // thinking) — content[0] isn't reliably the text block, so find it explicitly.
    const answer = aiData.content?.find((block: any) => block.type === 'text')?.text ?? '';

    return new Response(JSON.stringify({
      answer,
      sources: (matches || []).map((doc: any) => ({
        id: doc.id,
        content: doc.content,
        similarity: doc.similarity,
        matter_id: doc.matter_id,
        document_type_id: doc.document_type_id,
      })),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in rag-query:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
