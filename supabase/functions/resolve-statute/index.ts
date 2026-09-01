import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { resolveStatute } from "../_shared/statuteResolver.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Single resolution path for a matter's Relevant Laws list: called both
// when an associate types a new Act name, and when they click "Find & add"
// on a needs_upload row (auto-detected or manually typed) to retry.
// Checks the shared library first, then scrapes pakistancode.gov.pk
// (statuteResolver.ts) if not already there, ingesting on success.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { actName, matterId, source = 'manual_typed' } = await req.json();

    if (!actName || !matterId) {
      return new Response(JSON.stringify({ error: 'actName and matterId are required' }), {
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

    // Already in the shared library under this or a close-enough name?
    const { data: existingDocs } = await supabase
      .from('documents')
      .select('metadata')
      .eq('is_statute', true)
      .ilike('metadata->>act_name', actName)
      .limit(1);

    let canonicalActName = actName;
    let status: 'available' | 'needs_upload';

    if (existingDocs && existingDocs.length > 0) {
      canonicalActName = (existingDocs[0].metadata as any)?.act_name ?? actName;
      status = 'available';
    } else {
      const result = await resolveStatute(actName);
      if (result.found) {
        canonicalActName = result.title;
        const { error: ingestError } = await supabase.functions.invoke('ingest-documents', {
          body: {
            content: result.text,
            metadata: {
              act_name: result.title,
              source: 'pakistancode.gov.pk',
              source_url: result.pageUrl,
              pdf_url: result.pdfUrl,
              scraped_at: new Date().toISOString(),
            },
            isStatute: true,
          },
        });
        status = ingestError ? 'needs_upload' : 'available';
        if (ingestError) console.error('Failed to ingest scraped statute:', ingestError);
      } else {
        status = 'needs_upload';
      }
    }

    // Preserve the row's original source on a re-resolve (e.g. "Find & add"
    // retry on an auto-detected row shouldn't relabel it as manually typed).
    const { data: existingRow } = await supabase
      .from('matter_relevant_laws')
      .select('id')
      .eq('matter_id', matterId)
      .eq('act_name', canonicalActName)
      .maybeSingle();

    if (existingRow) {
      await supabase.from('matter_relevant_laws').update({ status }).eq('id', existingRow.id);
    } else {
      await supabase.from('matter_relevant_laws').insert({
        matter_id: matterId,
        act_name: canonicalActName,
        status,
        source,
        added_by: user.id,
      });
    }

    return new Response(JSON.stringify({ actName: canonicalActName, status }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in resolve-statute:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
