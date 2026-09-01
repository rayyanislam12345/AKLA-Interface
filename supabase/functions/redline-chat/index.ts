import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { extractTextFromFile } from "../_shared/extractText.ts";
import { fetchGroundedContext } from "../_shared/retrieval.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Follow-up turns after an initial "Review with AI" pass (suggest-redline) —
// a lawyer asking a question about the review, or asking for another pass
// at something specific ("also check the indemnity clause"). Scoped to a
// document_version_id (not just matter_id), since a matter can have several
// documents under review in parallel; threads are lazily created on the
// first message the same way drafting-interview/rag-query already do.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { documentVersionId, threadId = null, instruction } = await req.json();

    if (!documentVersionId || !instruction) {
      return new Response(JSON.stringify({ error: 'documentVersionId and instruction are required' }), {
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
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    const voyageKey = Deno.env.get('VOYAGE_API_KEY');

    if (!anthropicKey) {
      return new Response(JSON.stringify({ error: 'Anthropic API key not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!voyageKey) {
      return new Response(JSON.stringify({ error: 'Voyage API key not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: version, error: versionError } = await supabase
      .from('document_versions')
      .select('id, storage_path, matter_document:matter_documents(id, matter_id, document_type_id, document_type:document_types(name))')
      .eq('id', documentVersionId)
      .single();

    if (versionError || !version) {
      return new Response(JSON.stringify({ error: 'Document version not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const matterDocument = (version as any).matter_document;
    const documentTypeId = matterDocument?.document_type_id ?? null;
    const documentTypeName = matterDocument?.document_type?.name ?? 'document';
    const matterId = matterDocument?.matter_id;

    const fileName = version.storage_path.split('/').pop() ?? 'document';
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('matter-documents')
      .download(version.storage_path);
    if (downloadError) throw new Error(`Failed to download file: ${downloadError.message}`);

    const { text: fullText } = await extractTextFromFile(fileData, fileName);
    if (!fullText || fullText.trim().length === 0) {
      throw new Error('No text content could be extracted from the document');
    }

    const [{ precedents, statutes }, { data: template }, { data: matterContext }, { data: existingSuggestions }] = await Promise.all([
      fetchGroundedContext(supabase, voyageKey, fullText, documentTypeId, matterId ?? null),
      documentTypeId
        ? supabase.from('document_type_templates').select('content_html').eq('document_type_id', documentTypeId).maybeSingle()
        : Promise.resolve({ data: null }),
      matterId
        ? supabase.from('matter_context').select('content').eq('matter_id', matterId).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from('redline_suggestions')
        .select('clause_reference, original_text, suggested_text, rationale, status')
        .eq('document_version_id', documentVersionId),
    ]);

    // Lazily create the thread on the first follow-up message — mirrors
    // drafting-interview/rag-query's threadId-continuation pattern.
    let activeThreadId = threadId;
    if (!activeThreadId) {
      const { data: newThread, error: threadError } = await supabase
        .from('ai_chat_threads')
        .insert({ matter_id: matterId ?? null, document_version_id: documentVersionId, title: `Review chat — ${documentTypeName}`, created_by: user.id })
        .select('id')
        .single();
      if (threadError) throw threadError;
      activeThreadId = newThread.id;
    }

    await supabase.from('ai_chat_messages').insert({ thread_id: activeThreadId, role: 'user', content: instruction });

    const matterContextSection = matterContext?.content?.trim()
      ? `\n\nCONTEXT CARRIED FORWARD ON THIS MATTER (curated by the team from prior work):\n${matterContext.content.trim()}`
      : '';

    const hasTemplate = Boolean(template?.content_html?.trim());
    const templateSection = hasTemplate
      ? `\n\nSTANDARD TEMPLATE FOR THIS DOCUMENT TYPE:\n${template!.content_html}`
      : '';

    const precedentSection = precedents.length > 0
      ? `\n\nPRECEDENT — excerpts from the firm's past ${documentTypeName} agreements:\n${precedents.map((p, i) => `[Precedent ${i + 1}]\n${p.content}`).join('\n\n---\n\n')}`
      : '';

    const statuteSection = statutes.length > 0
      ? `\n\nRELEVANT PAKISTANI LAW:\n${statutes.map((s, i) => `[${(s.metadata as any)?.act_name ?? `Statute ${i + 1}`}]\n${s.content}`).join('\n\n---\n\n')}`
      : '';

    const existingSuggestionsSection = existingSuggestions && existingSuggestions.length > 0
      ? `\n\nSUGGESTIONS ALREADY MADE ON THIS REVIEW (don't repeat these — the lawyer can already see them; ${existingSuggestions.filter((s) => s.status === 'accepted').length} accepted, ${existingSuggestions.filter((s) => s.status === 'rejected').length} rejected, ${existingSuggestions.filter((s) => s.status === 'pending').length} still pending):\n${existingSuggestions
          .map((s) => `- [${s.status}] ${s.clause_reference}: ${s.rationale}`)
          .join('\n')}`
      : '';

    const systemPrompt = `You are a legal drafting reviewer continuing a review of a "${documentTypeName}". The lawyer has a follow-up question or request about this review.${matterContextSection}${templateSection}${precedentSection}${statuteSection}${existingSuggestionsSection}

DOCUMENT BEING REVIEWED:
${fullText}

LAWYER'S MESSAGE:
${instruction}

If this calls for one or more new redline suggestions (e.g. "also check X", or a request that implies a specific new issue), include them. If it's a question or comment that doesn't need a new suggestion, return an empty suggestions array.

Respond with ONLY the following, no other text:
REPLY: <a short, one to three sentence reply for the lawyer>
SUGGESTIONS: <a JSON array of {"clause_reference": string, "original_text": string, "suggested_text": string, "rationale": string} objects, or [] if none. "original_text" must be an exact verbatim substring of the document above.>`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: instruction }],
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('Anthropic API error:', aiResponse.status, errorText);
      return new Response(JSON.stringify({ error: 'AI provider error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const aiData = await aiResponse.json();
    const rawText: string = aiData.content?.find((block: any) => block.type === 'text')?.text ?? '';

    const replyMatch = rawText.match(/REPLY:\s*([\s\S]*?)(?=\n?SUGGESTIONS:)/);
    const reply = replyMatch ? replyMatch[1].trim() : rawText.trim();

    let newSuggestionsRaw: Array<{ clause_reference: string; original_text: string; suggested_text: string; rationale: string }> = [];
    try {
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      if (jsonMatch) newSuggestionsRaw = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(newSuggestionsRaw)) newSuggestionsRaw = [];
    } catch {
      newSuggestionsRaw = [];
    }

    await supabase.from('ai_chat_messages').insert({ thread_id: activeThreadId, role: 'assistant', content: reply });

    let newSuggestions: any[] = [];
    if (newSuggestionsRaw.length > 0) {
      const { data: insertedRows, error: insertError } = await supabase
        .from('redline_suggestions')
        .insert(
          newSuggestionsRaw.map((s) => ({
            document_version_id: documentVersionId,
            clause_reference: s.clause_reference,
            original_text: s.original_text,
            suggested_text: s.suggested_text,
            rationale: s.rationale,
            review_type: 'chat',
            status: 'pending',
          }))
        )
        .select();
      if (insertError) throw insertError;
      newSuggestions = insertedRows;
    }

    return new Response(JSON.stringify({ threadId: activeThreadId, reply, newSuggestions }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in redline-chat:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
