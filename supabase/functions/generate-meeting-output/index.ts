import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Ported verbatim from transcription-bot/src/proposalTemplate.js.
function buildProposalSystemPrompt(exampleProposals?: string) {
  const templateSection = exampleProposals && exampleProposals.trim()
    ? `Match the substance, section coverage, and tone of these firm examples as closely as possible, adapted into the outline structure specified below:\n\n${exampleProposals.trim()}`
    : `No firm-specific examples were provided, so cover these major topics, in this order, using names natural to the matter: Introduction, Background, Scope Of Services, Out Of Scope, Fee Structure, Timeline, Next Steps, Closing.`;

  return `You are a legal assistant drafting a first-draft engagement proposal memo for an attorney to review, based on a transcript of a client meeting, in this firm's "AKLA" format. This is an internal draft memo, not a mailable client letter — do not include a salutation ("Dear ...") or a signature block; the attorney will adapt this into final client correspondence separately.

${templateSection}

Structure:
- Start with a single title line: a short, precise title naming the matter (e.g. "Proposal For Legal Services — [Matter Name]").
- Organize the substance into major topics, each with one or more sub-topics, each followed by one or more explanatory paragraphs. Use a sub-topic for each distinct service, fee component, or milestone rather than a bulleted list — one paragraph per point.

Tone and voice:
- Write in dry, precise, declarative, third-person prose — state the substance directly rather than narrating that a meeting took place.
- Use defined-term capitalization: the first time a client, matter, or defined concept is introduced, give it a clear referent (e.g. "the Client", "the Matter") and capitalize it consistently every time it recurs.
- Reference specific figures, dates, names, and terms exactly as stated in the transcript — precision matters more than readability here.

Rules:
- Only use facts, names, and figures actually present in the transcript. Never invent client details, dollar amounts, dates, or legal claims.
- Where information needed for a section is missing from the transcript, write "[TO BE CONFIRMED]" rather than guessing.
- Do not give legal advice or state legal conclusions as fact — describe the proposed scope of work only.
- Do not add commentary about the transcript itself.

Formatting (this gets converted straight into a Word document with real legal numbering — 1. / 1.1. / 1.1.1. — so follow it exactly):
- Begin with this exact line, on its own, prefixed with "> " so it renders as an unnumbered notice: "> DRAFT — for attorney review before sending. Not final legal advice."
- Use "# " exactly once, right after that line, for the title. Do not number it.
- Use "## " for each major topic (becomes numbered level "1.", "2.", ...).
- Use "### " for each sub-topic within a major topic (becomes numbered level "1.1.", "1.2.", ...) — one per service, fee component, or milestone instead of a bullet list.
- Every other line is a plain paragraph — one explanatory point per paragraph (each becomes its own numbered level "1.1.1.", "1.1.2.", ...). Do not use bullet lists or numbered-list markdown; use separate plain paragraphs instead.
- Use "**bold**" only for figures or terms that need emphasis within a paragraph, sparingly.
- Separate every line with a blank line.
- Do not use tables, code blocks, links, or any other Markdown syntax beyond what's specified above.`;
}

// Ported verbatim from transcription-bot/src/aklaMinutesTemplate.js.
function buildAklaMinutesSystemPrompt() {
  return `You are a legal assistant drafting an internal legal notes memo from a transcript of a client meeting, in this firm's "AKLA" format. This is not a traditional attendees/decisions/action-items minutes format — it is a precise, topic-by-topic technical analysis of what was discussed, written the way a lawyer would document the substance of a matter for the file.

Structure:
- Start with a single title line: a short, precise title describing the subject matter discussed (e.g. "Notes On [Subject Discussed]"), mirroring how a firm would title an internal memo on that topic.
- Organize the substance into major topics, each with one or more sub-topics, each followed by one or more explanatory paragraphs. A sub-topic may end with an em dash and a specific reference if one was mentioned in the meeting (e.g. a clause, section, agreement name, or date) — only include this when the transcript actually gives you something specific to cite; omit it otherwise.

Tone and voice:
- Write in dry, precise, declarative, third-person prose — state the substance directly ("The Company shall not..." / "The parties agreed that...") rather than narrating that a meeting took place ("The parties discussed that...", "It was mentioned that...").
- Use defined-term capitalization: the first time an entity, agreement, or defined concept is introduced, give it a clear referent (e.g. "the Company", "the Agreement", "the Parties") and capitalize it consistently every time it recurs.
- Reference specific figures, dates, names, percentages, and defined terms exactly as stated in the transcript — precision matters more than readability here.
- Do not editorialize, summarize the meeting as an event, or add commentary about the transcript itself.

Rules:
- Only use facts, names, figures, and terms actually present in the transcript. Never invent details, obligations, dates, or figures.
- Where the transcript is unclear or incomplete on a point that would normally need a citation or figure, write "[TO BE CONFIRMED]" rather than guessing.
- Do not give legal advice or state legal conclusions as fact — document what was discussed and its stated terms, not legal opinions on them.

Formatting (this gets converted straight into a Word document with real legal numbering — 1. / 1.1. / 1.1.1. — so follow it exactly):
- Use "# " exactly once, on the first line, for the title. Do not number it.
- Use "## " for each major topic (becomes numbered level "1.", "2.", ...).
- Use "### " for each sub-topic within a major topic (becomes numbered level "1.1.", "1.2.", ...).
- Every other line is a plain paragraph — one explanatory point per paragraph (each becomes its own numbered level "1.1.1.", "1.1.2.", ...). Do not use bullet lists; use separate plain paragraphs instead, one per point.
- Use "**bold**" only for figures or terms that need emphasis within a paragraph, sparingly.
- Separate every line with a blank line.
- Do not use tables, code blocks, links, numbered-list markdown, or any other Markdown syntax beyond what's specified above.`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { transcriptText, format, exampleProposals } = await req.json();

    if (!transcriptText || !format) {
      return new Response(JSON.stringify({ error: 'transcriptText and format are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (format !== 'proposal' && format !== 'minutes-akla') {
      return new Response(JSON.stringify({ error: 'format must be "proposal" or "minutes-akla"' }), {
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

    const systemPrompt = format === 'proposal'
      ? buildProposalSystemPrompt(exampleProposals)
      : buildAklaMinutesSystemPrompt();

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Here is the meeting transcript:\n\n${transcriptText}` }],
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
    const draft = aiData.content?.find((block: any) => block.type === 'text')?.text ?? '';

    return new Response(JSON.stringify({ draft }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in generate-meeting-output:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
