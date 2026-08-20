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
    const { matterId, documentTypeId, threadId = null, message = null } = await req.json();

    if (!matterId || !documentTypeId) {
      return new Response(JSON.stringify({ error: 'matterId and documentTypeId are required' }), {
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

    const [{ data: documentType }, { data: matter }] = await Promise.all([
      supabase.from('document_types').select('name, category, required_fields').eq('id', documentTypeId).single(),
      supabase.from('matters').select('name, sector, matter_type, client:clients(name)').eq('id', matterId).single(),
    ]);

    if (!documentType || !matter) {
      return new Response(JSON.stringify({ error: 'Matter or document type not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Ensure a thread exists
    let activeThreadId = threadId;
    if (!activeThreadId) {
      const { data: thread, error: threadError } = await supabase
        .from('ai_chat_threads')
        .insert({
          matter_id: matterId,
          title: `Draft intake: ${documentType.name}`,
          created_by: user.id,
        })
        .select('id')
        .single();
      if (threadError) throw threadError;
      activeThreadId = thread.id;
    }

    // Record the incoming user message (skip on the very first call, which just kicks off the interview)
    if (message) {
      const { error: insertUserMsgError } = await supabase.from('ai_chat_messages').insert({
        thread_id: activeThreadId,
        role: 'user',
        content: message,
      });
      if (insertUserMsgError) throw insertUserMsgError;
    }

    let { data: history, error: historyError } = await supabase
      .from('ai_chat_messages')
      .select('role, content')
      .eq('thread_id', activeThreadId)
      .order('created_at');
    if (historyError) throw historyError;

    // Anthropic requires the conversation to start with a `user` message and
    // strictly alternate — persist the interview's opening seed rather than
    // only using it in-memory, or the second turn breaks that alternation.
    if (!history || history.length === 0) {
      const seedMessage = "Let's begin the intake interview.";
      const { error: seedError } = await supabase.from('ai_chat_messages').insert({
        thread_id: activeThreadId,
        role: 'user',
        content: seedMessage,
      });
      if (seedError) throw seedError;
      history = [{ role: 'user', content: seedMessage }];
    }

    const requiredFieldsHint = Array.isArray(documentType.required_fields) && documentType.required_fields.length > 0
      ? `\n\nThe firm has flagged these fields as required for this document type: ${JSON.stringify(documentType.required_fields)}.`
      : '';

    const systemPrompt = `You are a legal drafting assistant conducting a structured intake interview to gather what's needed to draft a "${documentType.name}" (${documentType.category}) for the matter "${matter.name}"${(matter as any).client?.name ? ` (client: ${(matter as any).client.name})` : ''}${matter.sector ? `, sector: ${matter.sector}` : ''}.${requiredFieldsHint}

Ask ONE focused question at a time about the commercial and legal terms needed to draft a solid first version — parties/roles, term or period, payment/tariff structure, performance security, governing law, dispute resolution, termination, and any other essentials specific to this document type. Keep each question short and concrete.

Respond with ONLY a JSON object, no other text, matching exactly this shape:
{"ready": boolean, "message": string}

Set "ready" to false and "message" to your next question while you still need more information. Once you have enough to draft a solid first version, set "ready" to true and "message" to a concise bullet-point summary of everything gathered.`;

    const anthropicMessages = history.map((m: { role: string; content: string }) => ({
      role: m.role,
      content: m.content,
    }));

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
        messages: anthropicMessages,
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
    const rawText: string =
      aiData.content?.find((block: any) => block.type === 'text')?.text ?? '{}';

    let parsed: { ready?: boolean; message?: string };
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
    } catch {
      parsed = { ready: false, message: rawText };
    }

    const replyText = parsed.message ?? rawText;
    const isReady = parsed.ready === true;

    const { error: insertAssistantMsgError } = await supabase.from('ai_chat_messages').insert({
      thread_id: activeThreadId,
      role: 'assistant',
      content: replyText,
    });
    if (insertAssistantMsgError) throw insertAssistantMsgError;

    return new Response(JSON.stringify({
      threadId: activeThreadId,
      reply: replyText,
      isReadyToDraft: isReady,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in drafting-interview:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
