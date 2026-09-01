import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { extractTextFromFile } from "../_shared/extractText.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Best-effort scan for statute mentions in a newly-uploaded matter document,
// auto-populating the matter's Relevant Laws list. Deliberately shallow:
// only a cheap Claude call + a fast library lookup — never scrapes/ingests
// a new statute synchronously here, since that could be slow for a large
// Act and this runs inline in the upload's own request/response cycle.
// Acts not already in the library are just flagged 'needs_upload' for an
// associate to resolve on demand (via resolve-statute) instead.
async function detectRelevantLaws(supabase: any, anthropicKey: string, matterId: string, text: string) {
  const excerpt = text.slice(0, 6000);
  const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      system: 'List the names of Pakistani statutes/Acts/Ordinances explicitly mentioned in the following text (formal names where possible, e.g. "Companies Act, 2017"). Respond with ONLY a JSON array of strings, no other text. Empty array if none mentioned.',
      messages: [{ role: 'user', content: excerpt }],
    }),
  });
  if (!aiResponse.ok) return;

  const aiData = await aiResponse.json();
  const rawText: string = aiData.content?.find((b: any) => b.type === 'text')?.text ?? '[]';

  let actNames: string[];
  try {
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    actNames = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
    if (!Array.isArray(actNames)) actNames = [];
  } catch {
    return;
  }
  if (actNames.length === 0) return;

  for (const name of actNames) {
    const { data: libraryMatch } = await supabase
      .from('documents')
      .select('metadata')
      .eq('is_statute', true)
      .ilike('metadata->>act_name', name)
      .limit(1);
    const found = libraryMatch && libraryMatch.length > 0;
    const canonicalName = found ? (libraryMatch[0].metadata as any).act_name : name;

    // ignoreDuplicates so two detected phrasings resolving to the same
    // canonical Act (or a re-scan of the same document) don't error on the
    // (matter_id, act_name) unique constraint.
    await supabase.from('matter_relevant_laws').upsert(
      {
        matter_id: matterId,
        act_name: canonicalName,
        status: found ? 'available' : 'needs_upload',
        source: 'auto_detected',
      },
      { onConflict: 'matter_id,act_name', ignoreDuplicates: true }
    );
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader = req.headers.get('Authorization')!;

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      filePath,
      fileName,
      fileType,
      bucket = 'matter-documents',
      matterId = null,
      documentTypeId = null,
      isPrecedent = false,
      isStatute = false,
      actName = null,
    } = await req.json();

    console.log('Processing document:', { filePath, fileName, fileType, bucket });

    // Download file from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from(bucket)
      .download(filePath);

    if (downloadError) {
      console.error('Error downloading file:', downloadError);
      throw new Error(`Failed to download file: ${downloadError.message}`);
    }

    const { text: extractedText, metadata: extractMetadata } = await extractTextFromFile(fileData, fileName);

    const metadata: any = {
      filename: fileName,
      file_type: fileType,
      upload_date: new Date().toISOString(),
      storage_path: filePath,
      storage_bucket: bucket,
      file_size: fileData.size,
      ...extractMetadata,
      // For a manually-uploaded statute (the Relevant Laws "needs upload"
      // fallback) — every other statute-matching code path keys off
      // metadata.act_name, so this has to be set explicitly here since
      // there's no scrape step to derive it from a page title.
      ...(actName ? { act_name: actName, source: 'manual_upload' } : {}),
    };

    console.log(`Extracted ${extractedText.length} characters (${extractMetadata.original_format})`);

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error('No text content could be extracted from the document');
    }

    // Call ingest-documents function with extracted text
    const { data: ingestData, error: ingestError } = await supabase.functions.invoke(
      'ingest-documents',
      {
        body: {
          content: extractedText,
          metadata,
          matterId,
          documentTypeId,
          isPrecedent,
          isStatute,
        },
      }
    );

    if (ingestError) {
      console.error('Error ingesting document:', ingestError);
      throw new Error(`Failed to ingest document: ${ingestError.message}`);
    }

    console.log('Document processed successfully:', ingestData);

    // Best-effort: scan genuine matter documents (not precedent/statute
    // ingestions themselves) for statute mentions. Never fails the upload.
    if (matterId && !isPrecedent && !isStatute) {
      const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
      if (anthropicKey) {
        try {
          await detectRelevantLaws(supabase, anthropicKey, matterId, extractedText);
        } catch (err) {
          console.error('Statute auto-detection failed (non-fatal):', err);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        chunks_created: ingestData.chunks_created,
        characters_extracted: extractedText.length,
        metadata,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error: any) {
    console.error('Error in process-document function:', error);
    return new Response(
      JSON.stringify({
        error: error.message || 'Failed to process document',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
