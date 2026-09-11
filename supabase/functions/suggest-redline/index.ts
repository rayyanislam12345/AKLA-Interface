import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { extractTextFromFile } from "../_shared/extractText.ts";
import { fetchGroundedContext } from "../_shared/retrieval.ts";

import { unzipSync } from "https://esm.sh/fflate@0.8.3";
import { inspectPackage, compareFormat } from "../_shared/docxChecks.js";
import { parseSuggestions } from "../_shared/reviewValidation.js";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type ReviewType = 'legal_clauses' | 'formatting' | 'content_conflicts';

// The firm's standard for a Concession Agreement is 526,000 characters. Two
// of the three passes quote the standard, so sending it whole put half a
// megabyte into each prompt and killed the function on its memory limit —
// and cost about 130,000 input tokens a pass for material no reviewer needs
// in full. An excerpt establishes the convention; the pass is told it is one.
const MAX_TEMPLATE_CHARS = 40_000;

// Retrieved chunks are not small: precedent rows in this database average
// 54,000 characters and the largest is 11MB, a whole document in one row.
// Five of those in a prompt is what exhausts the function's memory. The chat
// endpoint has capped its sources at 8,000 characters for this reason; the
// review passes now do the same.
const MAX_EXCERPT_CHARS = 8_000;
const excerpt = (text: string) => String(text ?? '').slice(0, MAX_EXCERPT_CHARS);

interface RawSuggestion {
  clause_reference: string;
  original_text: string;
  suggested_text: string;
  rationale: string;
}

const SUGGESTION_FORMAT_RULES = `Respond with ONLY a JSON array, no other text, of suggestion objects matching exactly this shape:
[{"clause_reference": string, "original_text": string, "suggested_text": string, "rationale": string}]

Rules:
- "original_text" MUST be an exact, verbatim substring copied from the draft above (so it can be located and replaced) — do not paraphrase it.
- "clause_reference" is a short human label for where this is (e.g. "Section 4.2" or "Governing Law clause").
- Only flag genuine, material issues within this pass's scope — not stylistic nitpicks, and not issues that belong to one of the other passes described above. If nothing in scope is wrong, return fewer suggestions rather than padding the list.
- Return material suggestions ordered by importance, at most 20. Do not claim this is an exhaustive legal clearance.
- If there is nothing worth flagging, return an empty array [].`;

function buildLegalClausesPrompt(
  documentTypeName: string,
  fullText: string,
  matterContextSection: string,
  templateSection: string,
  precedentSection: string,
  statuteSection: string
) {
  return `You are a legal drafting reviewer running ONE specific pass over a draft ${documentTypeName}: legal clause correctness and citation of legal assertions. Two other passes (formatting/structure, and content conflicts) run separately — stay within your lane.

Your scope, exactly two things:
1. For each substantive legal clause (e.g. indemnification, termination, governing law, limitation of liability, tax, dispute resolution, force majeure, conditions precedent, representations and warranties), check whether it has been applied correctly: does its substance comply with the Pakistani law excerpts below, and does it match how the firm's precedent normally drafts that clause (missing standard protections, non-standard allocation of risk, etc.)?
2. Separately, flag any sentence that makes a LEGAL ASSERTION — a claim about a legal right, obligation, exemption, compliance status, or statutory requirement — without citing the specific law, section, or precedent basis for that claim. E.g. "This Agreement is exempt from stamp duty" with no statute or section named.

Explicitly OUT OF SCOPE for this pass — do not flag: formatting, numbering, heading structure, or defined-term capitalization (a separate pass covers that); and conflicts with other documents on this matter (a separate pass covers that too).${matterContextSection}${templateSection}${precedentSection}${statuteSection}

DRAFT TO REVIEW:
${fullText}

${SUGGESTION_FORMAT_RULES}`;
}

function buildFormattingPrompt(
  documentTypeName: string,
  fullText: string,
  templateSection: string,
  precedentSection: string
) {
  return `You are a legal drafting reviewer running ONE specific pass over a draft ${documentTypeName}: formatting and structural consistency against the firm's own convention. Two other passes (legal clause correctness/citations, and content conflicts) run separately — stay within your lane.

Your scope: compare ONLY the document's formatting and structural conventions against the standard template and precedent below — clause/section numbering scheme, heading and sub-heading structure, defined-term capitalization consistency (is a defined term capitalized the same way every time it recurs?), recitals structure, execution block format, cross-reference style (e.g. "Section 4.2" vs "Clause 4.2" used inconsistently), and textual defined-term conventions. You receive extracted text, not rendered Word formatting: do not claim to have checked bold, italics, fonts, margins, spacing, or headers/footers.

Explicitly OUT OF SCOPE for this pass — do not flag: whether a clause is legally correct or complete, missing legal citations, or conflicts with other documents on this matter (separate passes cover those). Do not comment on what a clause says — only on how it is structured or formatted. If the document's formatting already matches precedent/template, say so by returning an empty array rather than inventing nitpicks.${templateSection}${precedentSection}

DRAFT TO REVIEW:
${fullText}

${SUGGESTION_FORMAT_RULES}`;
}

function buildContentConflictsPrompt(
  documentTypeName: string,
  fullText: string,
  matterContextSection: string,
  precedentSection: string,
  matterDocumentsSection: string
) {
  return `You are a legal drafting reviewer running ONE specific pass over a draft ${documentTypeName}: content against precedent, and content against the matter's other documents. Two other passes (legal clause correctness/citations, and formatting) run separately — stay within your lane.

Your scope, exactly two things:
1. Compare the document's commercial and substantive content against the firm's precedent below for standard market practice — flag unusual or one-sided terms, or standard commercial protections that are missing.
2. Compare the document's content against the OTHER documents from this same matter, provided below — flag any factual or substantive CONFLICT between this draft and those documents: mismatched dates, party names, defined terms, monetary figures or percentages, or an obligation/statement in this draft that contradicts what another document on this matter states.

Explicitly OUT OF SCOPE for this pass — do not flag: whether a clause cites the correct law (a separate pass covers legal citations), and formatting/numbering/structural issues (a separate pass covers that too).${matterContextSection}${precedentSection}${matterDocumentsSection}

DRAFT TO REVIEW:
${fullText}

${SUGGESTION_FORMAT_RULES}`;
}

async function runReviewPass(
  anthropicKey: string,
  reviewType: ReviewType,
  systemPrompt: string,
  documentTypeName: string,
  fullText: string
): Promise<RawSuggestion[]> {
  const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      // A real agreement yields long, verbatim-quoting suggestions: 12k of
      // output truncated the pass on a 58k-character term sheet, and a
      // truncated pass is failed rather than reported clean, so the review
      // could not complete at all. Room for the whole pass, and a cap on how
      // many findings it may return so the ceiling is not reached again.
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Run the ${reviewType.replace('_', ' ')} pass over the ${documentTypeName} now.` }],
    }),
  });

  if (!aiResponse.ok) {
    const errorText = await aiResponse.text();
    console.error(`Anthropic API error (${reviewType}):`, aiResponse.status, errorText);
    throw new Error(`AI provider error during ${reviewType} pass`);
  }

  const aiData = await aiResponse.json();
  // Claude can emit a `thinking` block ahead of the `text` block (extended
  // thinking) — content[0] isn't reliably the text block, so find it explicitly.
  const rawText: string = aiData.content?.find((block: any) => block.type === 'text')?.text ?? '[]';

  return parseSuggestions(rawText, aiData.stop_reason, fullText);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  let runId: string | null = null;
  let reviewDb: any = null;
  try {
    const { documentVersionId, researchRunId = null } = await req.json();

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

    reviewDb = supabase;
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
    const matterId = matterDocument?.matter_id;

    const fileName = version.storage_path.split('/').pop() ?? 'document';
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('matter-documents')
      .download(version.storage_path);

    if (downloadError) {
      console.error('Error downloading file:', downloadError);
      throw new Error(`Failed to download file: ${downloadError.message}`);
    }

    const digest = await crypto.subtle.digest('SHA-256', await fileData.arrayBuffer());
    const sourceHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const { data: run, error: runError } = await supabase.from('ai_review_runs').insert({ document_version_id: documentVersionId, source_hash: sourceHash, created_by: user.id }).select('id').single();
    if (runError) throw runError;
    runId = run.id;
    const { text: fullText } = await extractTextFromFile(fileData, fileName);
    if (!fullText || fullText.trim().length === 0) {
      throw new Error('No text content could be extracted from the document');
    }

    let researchNames: string[] = [];
    let researchLimits: unknown = null;
    if (researchRunId) {
      const { data: research } = await supabase.from('ai_research_runs').select('*').eq('id', researchRunId).eq('matter_id', matterId).maybeSingle();
      if (!research) throw new Error('Research does not belong to this project');
      researchNames = (research.sources ?? []).map((s: any) => s.metadata?.act_name).filter(Boolean);
      researchLimits = { status: research.status, unresolved: research.unresolved };
    }
    const [{ precedents, statutes, matterDocuments }, { data: template }, { data: matterContext }] = await Promise.all([
      fetchGroundedContext(
        supabase,
        voyageKey,
        fullText,
        documentTypeId ?? null,
        matterId ?? null,
        5,
        9,
        true,
        version.storage_path,
        12,
        researchNames
      ),
      documentTypeId
        ? supabase.from('document_type_templates').select('content_html, format_rules, storage_path').eq('document_type_id', documentTypeId).maybeSingle()
        : Promise.resolve({ data: null }),
      matterId
        ? supabase.from('matter_context').select('content').eq('matter_id', matterId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    let formatCheck: any = { status: 'not_checked', findings: [], limitation: 'An approved standard DOCX and a DOCX source are required for structural formatting comparison.' };
    let placeholders: any[] = [];
    if (/\.docx$/i.test(fileName)) {
      const decode = (blob: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(blob)).filter(([p]) => p.endsWith('.xml')).map(([p,b]) => [p, new TextDecoder().decode(b)]));
      const sourceParts = decode(new Uint8Array(await fileData.arrayBuffer()));
      const inspection = inspectPackage(sourceParts);
      if (inspection.errors.length) throw new Error(inspection.errors.join('; '));
      placeholders = inspection.placeholders;
      if (template?.storage_path) {
        const { data: standardFile, error } = await supabase.storage.from('precedent-library').download(template.storage_path);
        if (error || !standardFile) throw new Error('Could not load the approved standard for formatting checks');
        formatCheck = compareFormat(sourceParts, decode(new Uint8Array(await standardFile.arrayBuffer())));
      }
    }

    const matterContextSection = matterContext?.content?.trim()
      ? `\n\nCONTEXT CARRIED FORWARD ON THIS MATTER (curated by the team from prior work):\n${matterContext.content.trim()}`
      : '';

    if (template?.storage_path) await supabase.from('ai_review_runs').update({ template_path: template.storage_path }).eq('id', runId);
    const hasTemplate = Boolean(template?.content_html?.trim());
    const templateText = template?.content_html ?? '';
    const templateSection = hasTemplate
      ? `\n\nSTANDARD TEMPLATE FOR THIS DOCUMENT TYPE — the firm's canonical structure and formatting for a ${documentTypeName}${templateText.length > MAX_TEMPLATE_CHARS ? `, the opening ${MAX_TEMPLATE_CHARS} characters of it` : ''}. Flag divergences from this, not just from the precedent excerpts below:\n${templateText.slice(0, MAX_TEMPLATE_CHARS)}\nFormatting specification: ${template?.format_rules ?? "No formatting profile available"}`
      : '';

    const precedentSection = precedents.length > 0
      ? `\n\nPRECEDENT — excerpts from the firm's past ${documentTypeName} agreements, retrieved for relevance to this document, for comparison:\n${precedents
          .map((p, i) => `[Precedent ${i + 1}]\n${excerpt(p.content)}`)
          .join('\n\n---\n\n')}`
      : '\n\nNo precedent documents of this type are in the firm\'s library yet — flag divergences from standard market practice instead.';

    const statuteSection = statutes.length > 0
      ? `\n\nRELEVANT PAKISTANI LAW — excerpts from actual statute text, retrieved for relevance to this document. Flag anything in the draft that appears to conflict with these, or that asserts compliance with these without a correct citation:\n${statutes
          .map((s, i) => `[${(s.metadata as any)?.act_name ?? `Statute ${i + 1}`}]\n${excerpt(s.content)}`)
          .join('\n\n---\n\n')}`
      : '';

    const matterDocumentsSection = matterDocuments.length > 0
      ? `\n\nOTHER DOCUMENTS ALREADY ON THIS MATTER — excerpts from other files on this same matter, for checking internal consistency (dates, figures, defined terms, party names, obligations):\n${matterDocuments
          .map((d, i) => `[${(d.metadata as any)?.filename ?? `Document ${i + 1}`}]\n${excerpt(d.content)}`)
          .join('\n\n---\n\n')}`
      : '\n\nNo relevant excerpts from other project documents were retrieved. Cross-document consistency cannot be established.';

    // Together, not one after another: three passes in sequence over a real
    // agreement exceed the function's 150-second limit. They fit in memory
    // now that the template and every retrieved excerpt are capped, which is
    // what made running them at once fail before.
    const [legalClausesSuggestions, formattingSuggestions, contentConflictsSuggestions] = await Promise.all([
      runReviewPass(
        anthropicKey,
        'legal_clauses',
        buildLegalClausesPrompt(documentTypeName, fullText, matterContextSection, templateSection, precedentSection, statuteSection),
        documentTypeName,
        fullText
      ),
      runReviewPass(
        anthropicKey,
        'formatting',
        buildFormattingPrompt(documentTypeName, fullText, templateSection, precedentSection),
        documentTypeName,
        fullText
      ),
      runReviewPass(
        anthropicKey,
        'content_conflicts',
        buildContentConflictsPrompt(documentTypeName, fullText, matterContextSection, precedentSection, matterDocumentsSection),
        documentTypeName,
        fullText
      ),
    ]);

    const taggedSuggestions: Array<RawSuggestion & { review_type: ReviewType }> = [
      ...legalClausesSuggestions.map((s) => ({ ...s, review_type: 'legal_clauses' as const })),
      ...formattingSuggestions.map((s) => ({ ...s, review_type: 'formatting' as const })),
      ...contentConflictsSuggestions.map((s) => ({ ...s, review_type: 'content_conflicts' as const })),
    ];

    const passes = {
      legal_clauses: { status: statutes.length ? 'reviewed' : 'insufficient_evidence', findings: legalClausesSuggestions.length },
      formatting: { status: formatCheck.status, findings: formattingSuggestions.length + formatCheck.findings.length, note: formatCheck.limitation, comparison: formatCheck },
      content_conflicts: { status: matterDocuments.length ? 'partial' : 'insufficient_evidence', findings: contentConflictsSuggestions.length, note: 'Compared retrieved excerpts, not every project document.' },
    };
    const coverage = { documentCharacters: fullText.length, statuteExcerpts: statutes.length, precedentExcerpts: precedents.length, projectExcerpts: matterDocuments.length, placeholders, research: researchLimits, exhaustive: false };
    const { data: inserted, error: commitError } = await supabase.rpc('complete_ai_review', { p_run_id: runId, p_suggestions: taggedSuggestions, p_passes: passes, p_coverage: coverage });
    if (commitError) throw commitError;
    return new Response(JSON.stringify({
      fullText,
      reviewRunId: runId,
      passes,
      coverage,
      suggestions: inserted,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    if (runId && reviewDb) await reviewDb.from('ai_review_runs').update({ status: 'failed', error: error instanceof Error ? error.message : 'Review failed' }).eq('id', runId);
    console.error('Error in suggest-redline:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
