import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

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
    const { matterId, documentTypeId, mode = 'precedent', threadId = null } = await req.json();

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

    const [{ data: documentType }, { data: matter }, { data: parties }, { data: precedents }] = await Promise.all([
      supabase.from('document_types').select('name, category').eq('id', documentTypeId).single(),
      supabase.from('matters').select('name, sector, matter_type, description, client:clients(name)').eq('id', matterId).single(),
      supabase.from('matter_parties').select('name, role').eq('matter_id', matterId),
      supabase
        .from('documents')
        .select('content')
        .eq('document_type_id', documentTypeId)
        .eq('is_precedent', true)
        .order('created_at', { ascending: false })
        .limit(PRECEDENT_LIMIT),
    ]);

    if (!documentType || !matter) {
      return new Response(JSON.stringify({ error: 'Matter or document type not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let requirementsSection = '';
    if (mode === 'interview' && threadId) {
      const { data: messages } = await supabase
        .from('ai_chat_messages')
        .select('role, content')
        .eq('thread_id', threadId)
        .order('created_at');
      if (messages && messages.length > 0) {
        requirementsSection = `\n\nREQUIREMENTS GATHERED FROM INTAKE INTERVIEW WITH THE LAWYER:\n${messages
          .map((m) => `${m.role === 'user' ? 'Lawyer' : 'Assistant'}: ${m.content}`)
          .join('\n')}`;
      }
    }

    const partiesSection = parties && parties.length > 0
      ? `\n\nKNOWN PARTIES ON THIS MATTER:\n${parties.map((p) => `- ${p.name} (${p.role})`).join('\n')}`
      : '';

    const precedentSection = precedents && precedents.length > 0
      ? `\n\nPRECEDENT — excerpts from the firm's past ${documentType.name} agreements. Follow their structure, defined-term conventions, and drafting style, but do not copy client-identifying details:\n${precedents
          .map((p, i) => `[Precedent ${i + 1}]\n${p.content}`)
          .join('\n\n---\n\n')}`
      : '\n\nNo precedent documents of this type are in the firm\'s library yet — draft from standard market practice for this document type, and be conservative/generic where firm-specific convention is unknown.';

    const systemPrompt = `You are a legal drafting assistant. Draft a complete, professional first version of a "${documentType.name}" (${documentType.category}) for the matter "${matter.name}"${(matter as any).client?.name ? ` (client: ${(matter as any).client.name})` : ''}${matter.sector ? `, sector: ${matter.sector}` : ''}.${matter.description ? `\n\nMatter description: ${matter.description}` : ''}${partiesSection}${precedentSection}${requirementsSection}

Write the full document text with numbered clauses/sections and proper legal drafting conventions (defined terms capitalized on first use, recitals, operative clauses, execution block). Where a specific commercial term wasn't provided, insert a clearly marked placeholder like [CONCESSION PERIOD — TO BE CONFIRMED] rather than inventing a figure. This is a first draft for a lawyer to review and edit — it is not final.

Output ONLY the document text itself, no commentary before or after it.`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Draft the ${documentType.name} now.` }],
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
    const draft = aiData.content?.find((block: any) => block.type === 'text')?.text ?? '';

    return new Response(JSON.stringify({
      draft,
      precedentCount: precedents?.length ?? 0,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in draft-document:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
