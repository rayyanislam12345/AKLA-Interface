import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { extractTextFromFile } from "../_shared/extractText.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Caps so this stays a quick "extract the key facts" pass rather than a
// full-document analysis — plenty for parties/dates/terms, which are almost
// always established early in a document, without risking an unbounded
// prompt on a matter with many long documents.
const MAX_DOCUMENTS = 10;
const MAX_CHARS_PER_DOCUMENT = 15_000;

// Distills a matter's existing documents and past AI interview transcripts
// into a short, durable set of facts — returned as a proposal for the
// lawyer to review/edit, never written straight to matter_context, so a
// stray interview turn or misread document can't silently corrupt the
// matter's memory.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { matterId } = await req.json();

    if (!matterId) {
      return new Response(JSON.stringify({ error: 'matterId is required' }), {
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

    const [{ data: threads, error: threadsError }, { data: matterDocs, error: matterDocsError }] = await Promise.all([
      supabase.from('ai_chat_threads').select('id').eq('matter_id', matterId),
      supabase.from('matter_documents').select('id, title').eq('matter_id', matterId),
    ]);
    if (threadsError) throw threadsError;
    if (matterDocsError) throw matterDocsError;

    const threadIds = (threads ?? []).map((t) => t.id);
    const { data: messages, error: messagesError } = threadIds.length > 0
      ? await supabase
          .from('ai_chat_messages')
          .select('role, content, created_at')
          .in('thread_id', threadIds)
          .order('created_at')
      : { data: [], error: null };
    if (messagesError) throw messagesError;

    // Only the latest version of each matter document — earlier drafts are
    // superseded, not additional facts.
    const matterDocIds = (matterDocs ?? []).map((d) => d.id);
    const { data: allVersions, error: versionsError } = matterDocIds.length > 0
      ? await supabase
          .from('document_versions')
          .select('matter_document_id, storage_path, version_number')
          .in('matter_document_id', matterDocIds)
          .order('version_number', { ascending: false })
      : { data: [], error: null };
    if (versionsError) throw versionsError;

    const latestVersionByDoc = new Map<string, { storage_path: string }>();
    for (const v of allVersions ?? []) {
      if (!latestVersionByDoc.has(v.matter_document_id)) {
        latestVersionByDoc.set(v.matter_document_id, { storage_path: v.storage_path });
      }
    }

    const documentSections: string[] = [];
    let documentsRead = 0;
    for (const doc of matterDocs ?? []) {
      if (documentsRead >= MAX_DOCUMENTS) break;
      const version = latestVersionByDoc.get(doc.id);
      if (!version) continue; // no file uploaded yet for this matter document
      try {
        const { data: fileData, error: downloadError } = await supabase.storage
          .from('matter-documents')
          .download(version.storage_path);
        if (downloadError) throw downloadError;
        const fileName = version.storage_path.split('/').pop() ?? doc.title;
        const { text } = await extractTextFromFile(fileData, fileName);
        if (!text || text.trim().length === 0) continue;
        documentSections.push(`[Document: ${doc.title}]\n${text.trim().slice(0, MAX_CHARS_PER_DOCUMENT)}`);
        documentsRead++;
      } catch (err) {
        console.error(`Skipping document "${doc.title}" — extraction failed:`, err);
      }
    }

    if (documentSections.length === 0 && (!messages || messages.length === 0)) {
      return new Response(JSON.stringify({ summary: '', messageCount: 0, documentCount: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const documentsBlock = documentSections.length > 0
      ? `EXISTING DOCUMENTS ON THIS MATTER:\n\n${documentSections.join('\n\n---\n\n')}`
      : '';
    const transcriptBlock = messages && messages.length > 0
      ? `PAST AI DRAFTING-INTERVIEW SESSIONS ON THIS MATTER:\n\n${messages
          .map((m) => `${m.role === 'user' ? 'Lawyer' : 'Assistant'}: ${m.content}`)
          .join('\n')}`
      : '';

    const systemPrompt = `You are extracting a short, durable memo for a colleague picking up this legal matter later, from whatever is available: the matter's existing documents, and/or past AI drafting-interview sessions on it.

Extract only facts and decisions that will stay true and useful across future documents on this matter: parties, dates, commercial terms, drafting preferences, and open questions still unresolved. Do NOT restate document structure/boilerplate, do NOT include interview back-and-forth framing, and do NOT include anything specific to one already-finished document that wouldn't generalize.

Output a concise Markdown bullet list only, no preamble or commentary. If nothing durable is worth keeping, output a single bullet saying so.`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: [documentsBlock, transcriptBlock].filter(Boolean).join('\n\n') }],
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
    const summary = aiData.content?.find((block: any) => block.type === 'text')?.text ?? '';

    return new Response(JSON.stringify({
      summary,
      messageCount: messages?.length ?? 0,
      documentCount: documentSections.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in summarize-matter-context:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
