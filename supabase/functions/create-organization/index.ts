import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type CreateOrganizationBody = {
  name: string
  slug: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization') ?? '' },
        },
      }
    )

    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser()

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = (await req.json().catch(() => null)) as CreateOrganizationBody | null
    const name = body?.name?.trim()
    const slug = body?.slug?.trim()

    if (!name || !slug) {
      return new Response(JSON.stringify({ error: 'Missing name or slug' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: org, error: orgError } = await adminClient
      .from('organizations')
      .insert({ name, slug })
      .select('*')
      .single()

    if (orgError) {
      console.error('Organization creation error:', orgError.code, orgError.message)
      const status = orgError.code === '23505' ? 409 : 400
      const clientMessage = orgError.code === '23505' 
        ? 'An organization with this name already exists' 
        : 'Unable to create organization'
      return new Response(JSON.stringify({ error: clientMessage }), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { error: memberError } = await adminClient
      .from('organization_members')
      .insert({
        organization_id: org.id,
        user_id: user.id,
        role: 'owner',
      })

    if (memberError) {
      console.error('Member creation error:', memberError.code, memberError.message)
      return new Response(JSON.stringify({ error: 'Unable to add member to organization' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Also update the user's profile with the organization_id
    const { error: profileError } = await adminClient
      .from('profiles')
      .update({ organization_id: org.id })
      .eq('user_id', user.id)

    if (profileError) {
      console.error('Failed to update profile organization_id:', profileError)
      // Non-fatal: continue even if profile update fails
    }

    return new Response(JSON.stringify({ data: org }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('create-organization error:', error)
    return new Response(JSON.stringify({ error: 'An unexpected error occurred' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
