import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { unzipSync, zipSync } from "https://esm.sh/fflate@0.8.3";
import { DOMParser, XMLSerializer } from "https://esm.sh/@xmldom/xmldom@0.9.8";
import { applyRedlineToOxml, configureXmlProvider, validateRedlineOoxml } from "https://esm.sh/@ansonlai/docx-redline-js@0.2.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Deno has no native DOMParser/XMLSerializer — register a provider once at
// module load, before any applyRedlineToOxml call.
configureXmlProvider({ DOMParser, XMLSerializer });

// Applies every non-rejected redline_suggestion for a document version as
// GENUINE Word tracked-changes (<w:ins>/<w:del>) directly onto a copy of
// the actual uploaded .docx — not a rebuilt approximation. Preserves 100%
// of the original file's real formatting (fonts, tables, styles), since
// only the word/document.xml zip entry is touched; every other part is
// carried over byte-identical. Writes a live "preview" file, overwritten
// on every regeneration — not a new numbered document_versions row.
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
      .select('id, storage_path, matter_document_id, matter_document:matter_documents(matter_id)')
      .eq('id', documentVersionId)
      .single();

    if (versionError || !version) {
      return new Response(JSON.stringify({ error: 'Document version not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!version.storage_path.toLowerCase().endsWith('.docx')) {
      return new Response(JSON.stringify({ error: 'Only .docx documents support tracked-changes preview' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const matterId = (version as any).matter_document?.matter_id;
    const matterDocumentId = version.matter_document_id;

    const { data: fileData, error: downloadError } = await supabase.storage
      .from('matter-documents')
      .download(version.storage_path);
    if (downloadError) throw new Error(`Failed to download file: ${downloadError.message}`);

    const { data: suggestions, error: suggestionsError } = await supabase
      .from('redline_suggestions')
      .select('id, clause_reference, original_text, suggested_text, status')
      .eq('document_version_id', documentVersionId)
      .neq('status', 'rejected');
    if (suggestionsError) throw suggestionsError;

    const originalBytes = new Uint8Array(await fileData.arrayBuffer());
    const zipEntries = unzipSync(originalBytes);

    const documentXmlBytes = zipEntries['word/document.xml'];
    if (!documentXmlBytes) throw new Error('Not a valid .docx file (missing word/document.xml)');

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let oxml = decoder.decode(documentXmlBytes);

    let appliedCount = 0;
    const skipped: Array<{ suggestionId: string; clauseReference: string | null; reason: string }> = [];

    for (const s of suggestions ?? []) {
      if (!s.original_text || !s.suggested_text) {
        skipped.push({ suggestionId: s.id, clauseReference: s.clause_reference, reason: 'missing_text' });
        continue;
      }
      try {
        const result = await applyRedlineToOxml(oxml, s.original_text, s.suggested_text, {
          generateRedlines: true,
          author: 'AI Review',
        });
        if (result.status === 'error' || !result.hasChanges) {
          skipped.push({
            suggestionId: s.id,
            clauseReference: s.clause_reference,
            reason: result.error?.code ?? result.status ?? 'no_match',
          });
          continue;
        }
        oxml = result.oxml;
        appliedCount++;
      } catch (err) {
        console.error(`Failed to apply redline for suggestion ${s.id}:`, err);
        skipped.push({ suggestionId: s.id, clauseReference: s.clause_reference, reason: 'exception' });
      }
    }

    if (appliedCount > 0) {
      const validation = validateRedlineOoxml(oxml);
      if (validation && (validation as any).valid === false) {
        throw new Error(`Patched document failed validation: ${JSON.stringify((validation as any).errors)}`);
      }
    }

    zipEntries['word/document.xml'] = encoder.encode(oxml);
    const patchedZip = zipSync(zipEntries);

    const previewStoragePath = `${matterId}/${matterDocumentId}/redline-preview.docx`;
    const { error: uploadError } = await supabase.storage
      .from('matter-documents')
      .upload(previewStoragePath, patchedZip, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true,
      });
    if (uploadError) throw uploadError;

    return new Response(JSON.stringify({
      previewStoragePath,
      appliedCount,
      skippedCount: skipped.length,
      skipped,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in apply-redlines-to-docx:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
