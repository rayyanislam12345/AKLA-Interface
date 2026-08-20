import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { extractTextFromFile } from "../_shared/extractText.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PRECEDENT_LIMIT = 5;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { documentVersionId } = await req.json();

    if (!documentVersionId) {
      return new Response(JSON.stringify({ error: 'documentVersionId is required' }), {
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

    if (!anthropicKey) {
      return new Response(JSON.stringify({ error: 'Anthropic API key not configured' }), {
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
      .select('id, storage_path, matter_document:matter_documents(id, title, matter_id, document_type_id, document_type:document_types(name))')
      .eq('id', documentVersionId)
      .single();

    if (versionError || !version) {
      return new Response(JSON.stringify({ error: 'Document version not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const matterDocument = (version as any).matter_document;
    const documentTypeId = matterDocument?.document_type_id;
    const documentTypeName = matterDocument?.document_type?.name ?? 'document';

    const fileName = version.storage_path.split('/').pop() ?? 'document';
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('matter-documents')
      .download(version.storage_path);

    if (downloadError) {
      console.error('Error downloading file:', downloadError);
      throw new Error(`Failed to download file: ${downloadError.message}`);
    }

    const { text: fullText } = await extractTextFromFile(fileData, fileName);
    if (!fullText || fullText.trim().length === 0) {
      throw new Error('No text content could be extracted from the document');
    }

    const { data: precedents } = documentTypeId
      ? await supabase
          .from('documents')
          .select('content')
          .eq('document_type_id', documentTypeId)
          .eq('is_precedent', true)
          .order('created_at', { ascending: false })
          .limit(PRECEDENT_LIMIT)
      : { data: [] as { content: string }[] };

    const precedentSection = precedents && precedents.length > 0
      ? `\n\nPRECEDENT — excerpts from the firm's past ${documentTypeName} agreements, for comparison:\n${precedents
          .map((p, i) => `[Precedent ${i + 1}]\n${p.content}`)
          .join('\n\n---\n\n')}`
      : '\n\nNo precedent documents of this type are in the firm\'s library yet — flag divergences from standard market practice instead.';

    const systemPrompt = `You are a legal drafting reviewer. Review the following draft ${documentTypeName} against the firm's precedent and standard market practice. Flag specific issues: missing standard protections, unusual or one-sided terms, drafting inconsistencies, undefined terms used before definition, or clauses that diverge materially from the precedent excerpts.${precedentSection}

DRAFT TO REVIEW:
${fullText}

Respond with ONLY a JSON array, no other text, of suggestion objects matching exactly this shape:
[{"clause_reference": string, "original_text": string, "suggested_text": string, "rationale": string}]

Rules:
- "original_text" MUST be an exact, verbatim substring copied from the draft above (so it can be located and replaced) — do not paraphrase it.
- "clause_reference" is a short human label for where this is (e.g. "Section 4.2" or "Governing Law clause").
- Only flag genuine, material issues — not stylistic nitpicks. If the draft is solid, return fewer suggestions rather than padding the list.
- Return at most 12 suggestions, ordered by importance.
- If there is nothing worth flagging, return an empty array [].`;

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
        messages: [{ role: 'user', content: `Review the ${documentTypeName} now.` }],
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
    // Claude can emit a `thinking` block ahead of the `text` block (extended
    // thinking) — content[0] isn't reliably the text block, so find it explicitly.
    const rawText: string = aiData.content?.find((block: any) => block.type === 'text')?.text ?? '[]';

    let suggestions: Array<{ clause_reference: string; original_text: string; suggested_text: string; rationale: string }>;
    try {
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      suggestions = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
      if (!Array.isArray(suggestions)) suggestions = [];
    } catch {
      suggestions = [];
    }

    // Clear stale pending suggestions from a prior run so re-reviewing doesn't
    // pile up duplicates; accepted/rejected history is left alone.
    await supabase
      .from('redline_suggestions')
      .delete()
      .eq('document_version_id', documentVersionId)
      .eq('status', 'pending');

    let inserted: any[] = [];
    if (suggestions.length > 0) {
      const { data: insertedRows, error: insertError } = await supabase
        .from('redline_suggestions')
        .insert(
          suggestions.map((s) => ({
            document_version_id: documentVersionId,
            clause_reference: s.clause_reference,
            original_text: s.original_text,
            suggested_text: s.suggested_text,
            rationale: s.rationale,
            status: 'pending',
          }))
        )
        .select();
      if (insertError) throw insertError;
      inserted = insertedRows;
    }

    return new Response(JSON.stringify({
      fullText,
      suggestions: inserted,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in suggest-redline:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
