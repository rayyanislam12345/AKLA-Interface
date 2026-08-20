import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { extractTextFromFile } from "../_shared/extractText.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
        },
      }
    );

    if (ingestError) {
      console.error('Error ingesting document:', ingestError);
      throw new Error(`Failed to ingest document: ${ingestError.message}`);
    }

    console.log('Document processed successfully:', ingestData);

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
