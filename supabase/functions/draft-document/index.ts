import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { fetchGroundedContext } from "../_shared/retrieval.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { matterId, documentTypeId, threadId = null, currentDraft = null, instruction = null } = await req.json();

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

    const [{ data: documentType }, { data: matter }, { data: parties }, { data: template }, { data: matterContext }] = await Promise.all([
      supabase.from('document_types').select('name, category').eq('id', documentTypeId).single(),
      supabase.from('matters').select('name, sector, matter_type, description, client:clients(name)').eq('id', matterId).single(),
      supabase.from('matter_parties').select('name, role').eq('matter_id', matterId),
      supabase.from('document_type_templates').select('content_html').eq('document_type_id', documentTypeId).maybeSingle(),
      supabase.from('matter_context').select('content').eq('matter_id', matterId).maybeSingle(),
    ]);

    if (!documentType || !matter) {
      return new Response(JSON.stringify({ error: 'Matter or document type not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let requirementsSection = '';
    let transcriptText = '';
    if (threadId) {
      const { data: messages } = await supabase
        .from('ai_chat_messages')
        .select('role, content')
        .eq('thread_id', threadId)
        .order('created_at');
      if (messages && messages.length > 0) {
        transcriptText = messages.map((m) => `${m.role === 'user' ? 'Lawyer' : 'Assistant'}: ${m.content}`).join('\n');
        requirementsSection = `\n\nREQUIREMENTS GATHERED FROM INTAKE INTERVIEW WITH THE LAWYER:\n${transcriptText}`;
      }
    }

    // Semantic retrieval — what's actually similar to this document, not just
    // what was added most recently. Query text combines what's known about
    // the document to draft: its type, the matter, and anything gathered so
    // far in the interview.
    const retrievalQuery = [documentType.name, matter.description ?? '', transcriptText].filter(Boolean).join('\n');
    const { precedents, statutes } = await fetchGroundedContext(supabase, voyageKey, retrievalQuery, documentTypeId, matterId);

    const partiesSection = parties && parties.length > 0
      ? `\n\nKNOWN PARTIES ON THIS MATTER:\n${parties.map((p) => `- ${p.name} (${p.role})`).join('\n')}`
      : '';

    const matterContextSection = matterContext?.content?.trim()
      ? `\n\nCONTEXT CARRIED FORWARD ON THIS MATTER (curated by the team from prior work — treat as established fact unless it conflicts with something more specific below):\n${matterContext.content.trim()}`
      : '';

    const hasTemplate = Boolean(template?.content_html?.trim());
    const templateSection = hasTemplate
      ? `\n\nSTANDARD TEMPLATE FOR THIS DOCUMENT TYPE — this is the firm's canonical structure and formatting for a ${documentType.name}. Follow its clause structure and formatting conventions as the primary basis for this draft:\n${template!.content_html}`
      : '';

    const precedentSection = precedents.length > 0
      ? `\n\n${hasTemplate ? 'SUPPLEMENTARY EXAMPLES' : 'PRECEDENT'} — excerpts from the firm's past ${documentType.name} agreements, retrieved for relevance to this matter.${hasTemplate ? ' For reference on phrasing/edge cases only — defer to the standard template above for structure where they conflict.' : ' Follow their structure, defined-term conventions, and drafting style, but do not copy client-identifying details.'}\n${precedents
          .map((p, i) => `[Precedent ${i + 1}]\n${p.content}`)
          .join('\n\n---\n\n')}`
      : hasTemplate
      ? ''
      : '\n\nNo precedent documents of this type are in the firm\'s library yet — draft from standard market practice for this document type, and be conservative/generic where firm-specific convention is unknown.';

    const statuteSection = statutes.length > 0
      ? `\n\nRELEVANT PAKISTANI LAW — excerpts from actual statute text, retrieved for relevance to this document. Respect these where they impose requirements on the transaction; do not contradict them:\n${statutes
          .map((s, i) => `[${(s.metadata as any)?.act_name ?? `Statute ${i + 1}`}]\n${s.content}`)
          .join('\n\n---\n\n')}`
      : '';

    const baseContextSections = `${partiesSection}${matterContextSection}${templateSection}${precedentSection}${statuteSection}`;

    if (instruction) {
      // Revision turn — the lawyer is following up on an already-generated
      // draft, either asking for an edit or just a question. Instructed
      // plain-text output (not tool-use — see draft-document's history):
      // forcing a tool call for this would suppress extended thinking and
      // is worse at generating long free-form prose inside a JSON field,
      // both of which matter more here than for the small structured
      // outputs suggest-redline already gets away with the same way.
      const revisionPrompt = `You are a legal drafting assistant continuing work on a "${documentType.name}" (${documentType.category}) for the matter "${matter.name}". The lawyer has a follow-up instruction about the current draft.${baseContextSections}

CURRENT DRAFT:
${currentDraft}

LAWYER'S INSTRUCTION:
${instruction}

If the instruction asks for a change, revise the draft accordingly and return the FULL updated document (same Markdown formatting rules as the original draft: one "# " title, "## "/"### "/"#### " headings with no typed numbers, "- " lists with no typed letters). If the instruction is a question or comment that doesn't require changing the document, leave the draft as-is.

Respond with ONLY the following, no other text:
REPLY: <a short, one to three sentence reply for the lawyer — either confirming what you changed, or answering the question>
DOCUMENT_CHANGED: yes|no
---DOCUMENT---
<the full document text, only if DOCUMENT_CHANGED is yes>`;

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
          system: revisionPrompt,
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

      const replyMatch = rawText.match(/REPLY:\s*([\s\S]*?)(?=\n?DOCUMENT_CHANGED:)/);
      const changedMatch = rawText.match(/DOCUMENT_CHANGED:\s*(yes|no)/i);
      const documentMatch = rawText.match(/---DOCUMENT---\s*([\s\S]*)/);

      const reply = replyMatch ? replyMatch[1].trim() : rawText.trim();
      const documentChanged = changedMatch ? changedMatch[1].toLowerCase() === 'yes' : false;
      const updatedDraft = documentChanged && documentMatch ? documentMatch[1].trim() : currentDraft;

      if (threadId) {
        await supabase.from('ai_chat_messages').insert([
          { thread_id: threadId, role: 'user', content: instruction },
          { thread_id: threadId, role: 'assistant', content: reply },
        ]);
      }

      return new Response(JSON.stringify({ reply, updatedDraft, documentChanged }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const systemPrompt = `You are a legal drafting assistant. Draft a complete, professional first version of a "${documentType.name}" (${documentType.category}) for the matter "${matter.name}"${(matter as any).client?.name ? ` (client: ${(matter as any).client.name})` : ''}${matter.sector ? `, sector: ${matter.sector}` : ''}.${matter.description ? `\n\nMatter description: ${matter.description}` : ''}${baseContextSections}${requirementsSection}

Write the full document text with proper legal drafting conventions (defined terms capitalized on first use, recitals, operative clauses, execution block). Where a specific commercial term wasn't provided, insert a clearly marked placeholder like [CONCESSION PERIOD — TO BE CONFIRMED] rather than inventing a figure. This is a first draft for a lawyer to review and edit — it is not final.

Format the output as Markdown, matching the firm's clause-numbering convention exactly:
- Exactly one "# " heading, for the document title only (e.g. "# CONCESSION AGREEMENT").
- "## " for each top-level clause/section — heading text only (e.g. "## Definitions and Interpretation"). Do NOT type the clause number yourself; the numbering is generated automatically when this is exported, so a typed "1. " prefix would create a duplicate number.
- "### " for a sub-clause within a section, "#### " for one level deeper if genuinely needed — same rule, no typed numbers.
- Ordinary paragraphs for recitals and body text that isn't itself a numbered sub-item.
- A Markdown list ("- " per item) for enumerated sub-items within a clause (e.g. what would read as (a)/(b)/(c)) — again, don't type the letter/number yourself.
- Leave a blank line between clauses and before/after the execution block, the way a lawyer would when typing this directly in Word.

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
      precedentCount: precedents.length,
      hasTemplate,
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
