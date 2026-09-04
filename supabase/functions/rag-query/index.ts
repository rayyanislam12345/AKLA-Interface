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
      matchThreshold: requestedThreshold,
      matchCount = 5,
      statuteCount = 3,
      matterId = null,
      documentTypeId = null,
      precedentOnly = false,
      threadId = null,
    } = await req.json();

    // voyage-law-2 cosine similarities run well below what OpenAI-style
    // embeddings produce for genuinely relevant matches. Measured against
    // the live precedent library (47 documents) with typical lawyer
    // questions, the best-matching chunk scored anywhere from 0.38 ("what
    // termination payment regime applies on Grantor default?") to 0.67
    // ("how is force majeure defined?") — an earlier 0.5 bar silently
    // returned nothing for most questions. A short slide-deck bullet on the
    // matter itself measured 0.41-0.44 for a clean hit. This is the only
    // consumer of rag-query (the matter Ask tab), it returns at most
    // matchCount sources per scope, and the prompt tells the model to say
    // when the sources don't actually answer — so a low bar that favours
    // recall is the right trade here.
    const matchThreshold = requestedThreshold ?? 0.35;

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

    // Threaded persistence is opt-in: only when a matterId is supplied (the
    // matter Q&A chat UI). Precedent-library search stays stateless.
    let activeThreadId: string | null = threadId;
    let priorMessages: { role: string; content: string }[] = [];
    if (matterId) {
      if (!activeThreadId) {
        const { data: thread, error: threadError } = await supabase
          .from('ai_chat_threads')
          .insert({ matter_id: matterId, title: 'Matter Q&A', created_by: user.id })
          .select('id')
          .single();
        if (threadError) throw threadError;
        activeThreadId = thread.id;
      } else {
        const { data: history } = await supabase
          .from('ai_chat_messages')
          .select('role, content')
          .eq('thread_id', activeThreadId)
          .order('created_at');
        priorMessages = history ?? [];
      }

      const { error: insertUserMsgError } = await supabase.from('ai_chat_messages').insert({
        thread_id: activeThreadId,
        role: 'user',
        content: query,
      });
      if (insertUserMsgError) throw insertUserMsgError;
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

    // A matter question is grounded in three places: the matter's own
    // uploaded documents, the firm's precedent library, and the law library
    // — a lawyer asking "what did we agree on step-in rights" wants this
    // deal's draft, "how do we normally draft step-in rights" wants
    // precedent, and "does the stamp duty exemption we're claiming hold"
    // wants the Act, and the question rarely says which. All three run and
    // every source is labelled with where it came from so the answer can
    // say so too. Statute retrieval is scoped the same way Draft and Verify
    // scope it (see _shared/retrieval.ts): to the matter's Relevant Laws
    // list when it has one, the whole statute library otherwise. Without a
    // matter it's the single library-wide search it always was.
    type Match = { id: string; content: string; metadata: any; matter_id: string | null; document_type_id: string | null; similarity: number };
    type Scope = 'matter' | 'precedent' | 'statute';

    const { data: relevantLaws } = matterId
      ? await supabase.from('matter_relevant_laws').select('act_name').eq('matter_id', matterId).eq('status', 'available')
      : { data: null };
    const filterActNames = relevantLaws && relevantLaws.length > 0
      ? (relevantLaws as { act_name: string }[]).map((r) => r.act_name)
      : null;

    const [matterResult, libraryResult, statuteResult] = await Promise.all([
      matterId
        ? supabase.rpc('match_documents', {
            query_embedding: queryEmbedding,
            match_threshold: matchThreshold,
            match_count: matchCount,
            filter_matter_id: matterId,
            filter_document_type_id: documentTypeId,
          })
        : Promise.resolve({ data: [] as Match[], error: null }),
      supabase.rpc('match_documents', {
        query_embedding: queryEmbedding,
        match_threshold: matchThreshold,
        match_count: matchCount,
        filter_document_type_id: documentTypeId,
        precedent_only: matterId ? true : precedentOnly,
      }),
      matterId
        ? supabase.rpc('match_documents', {
            query_embedding: queryEmbedding,
            match_threshold: matchThreshold,
            match_count: statuteCount,
            statute_only: true,
            filter_act_names: filterActNames,
          })
        : Promise.resolve({ data: [] as Match[], error: null }),
    ]);

    const matchError = matterResult.error ?? libraryResult.error ?? statuteResult.error;
    if (matchError) {
      console.error('Error matching documents:', matchError);
      return new Response(JSON.stringify({ error: 'Failed to search documents' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const matches: Array<Match & { scope: Scope }> = [
      ...((matterResult.data ?? []) as Match[]).map((m) => ({ ...m, scope: 'matter' as const })),
      ...((libraryResult.data ?? []) as Match[]).map((m) => ({ ...m, scope: 'precedent' as const })),
      ...((statuteResult.data ?? []) as Match[]).map((m) => ({ ...m, scope: 'statute' as const })),
    ];

    console.log(`Found ${matches.length} matching documents (${matterResult.data?.length ?? 0} on the matter, ${libraryResult.data?.length ?? 0} precedent, ${statuteResult.data?.length ?? 0} statute${filterActNames ? ` from ${filterActNames.length} relevant law(s)` : ''})`);

    // Format context from matched documents
    const sourceLabel = (doc: Match & { scope: Scope }) => {
      const similarity = `similarity ${(doc.similarity * 100).toFixed(1)}%`;
      if (doc.scope === 'statute') return `statute — ${doc.metadata?.act_name ?? 'unknown Act'}; ${similarity}`;
      const filename = doc.metadata?.filename ? ` — ${doc.metadata.filename}` : '';
      const origin = matterId ? (doc.scope === 'matter' ? "this matter's document" : 'precedent library') : 'knowledge base';
      return `${origin}${filename}; ${similarity}`;
    };
    const context = matches.length > 0
      ? matches.map((doc, index) =>
          `[Source ${index + 1}] (${sourceLabel(doc)})\n${doc.content}`
        ).join('\n\n---\n\n')
      : 'No relevant documents found in the knowledge base.';

    const systemPrompt = `You are a legal assistant with access to the firm's knowledge base: the documents uploaded to the matter being discussed, the firm's precedent library of past agreements, and a law library of Pakistani statute text. Use the following sources, retrieved specifically for the latest question, to answer precisely and conservatively. Each source is labelled with where it came from — distinguish clearly between what THIS matter's documents say, what the firm's precedent shows, and what the law itself provides; when you rely on a statute, name the Act and the section. If the sources don't contain relevant information, say so clearly rather than guessing. Cite sources by number (e.g. "[Source 2]") when you rely on them.

KNOWLEDGE BASE SOURCES FOR THE LATEST QUESTION:
${context}`;

    const conversationMessages = [
      ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: query },
    ];

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
        messages: conversationMessages,
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

    if (activeThreadId) {
      const { error: insertAssistantMsgError } = await supabase.from('ai_chat_messages').insert({
        thread_id: activeThreadId,
        role: 'assistant',
        content: answer,
      });
      if (insertAssistantMsgError) throw insertAssistantMsgError;
    }

    return new Response(JSON.stringify({
      threadId: activeThreadId,
      answer,
      sources: matches.map((doc) => ({
        id: doc.id,
        content: doc.content,
        similarity: doc.similarity,
        matter_id: doc.matter_id,
        document_type_id: doc.document_type_id,
        scope: doc.scope,
        filename: doc.metadata?.filename ?? null,
        act_name: doc.metadata?.act_name ?? null,
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
