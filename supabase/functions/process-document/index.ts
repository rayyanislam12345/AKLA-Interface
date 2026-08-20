import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

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

    let extractedText = '';
    let metadata: any = {
      filename: fileName,
      file_type: fileType,
      upload_date: new Date().toISOString(),
      storage_path: filePath,
      storage_bucket: bucket,
      file_size: fileData.size,
    };

    // Determine file type and extract text
    const fileExtension = fileName.toLowerCase().split('.').pop();

    if (fileExtension === 'pdf') {
      // Extract text from PDF using unpdf (Deno-compatible)
      const { extractText, getDocumentProxy } = await import('https://esm.sh/unpdf@0.11.0');

      const arrayBuffer = await fileData.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // Get document metadata
      const documentProxy = await getDocumentProxy(uint8Array);
      const numPages = documentProxy.numPages;

      // Extract text from all pages
      const { text } = await extractText(uint8Array, { mergePages: true });
      extractedText = text;

      metadata.page_count = numPages;
      metadata.original_format = 'pdf';

      console.log(`Extracted ${text.length} characters from ${numPages} pages`);

    } else if (fileExtension === 'docx') {
      // Extract text from DOCX
      const mammoth = await import('https://esm.sh/mammoth@1.6.0');
      const arrayBuffer = await fileData.arrayBuffer();

      const result = await mammoth.extractRawText({ arrayBuffer });
      extractedText = result.value;
      metadata.original_format = 'docx';

      console.log(`Extracted ${result.value.length} characters from DOCX`);

    } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
      // Extract text from Excel
      const XLSX = await import('https://esm.sh/xlsx@0.18.5');
      const arrayBuffer = await fileData.arrayBuffer();

      const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
      const sheets: string[] = [];

      workbook.SheetNames.forEach((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const sheetData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        let sheetText = `[Sheet: ${sheetName}]\n`;
        sheetData.forEach((row: any, index: number) => {
          if (row && row.length > 0) {
            sheetText += `Row ${index + 1}: ${row.join(', ')}\n`;
          }
        });
        sheets.push(sheetText);
      });

      extractedText = sheets.join('\n\n');
      metadata.sheet_count = workbook.SheetNames.length;
      metadata.original_format = 'excel';

      console.log(`Extracted data from ${workbook.SheetNames.length} sheets`);

    } else {
      throw new Error(`Unsupported file type: ${fileExtension}`);
    }

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
