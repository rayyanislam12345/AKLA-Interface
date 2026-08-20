import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }
    )

    const { data: { user: caller }, error: authError } = await userClient.auth.getUser()
    if (authError || !caller) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const body = await req.json().catch(() => null)

    // Check if caller is a system admin
    const { data: systemAdminRole } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_id', caller.id)
      .eq('role', 'admin')
      .maybeSingle()

    const isSystemAdmin = !!systemAdminRole

    // Check which orgs the caller can administer
    const { data: orgMemberships, error: orgMembershipsError } = await adminClient
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', caller.id)
      .in('role', ['owner', 'admin'])
 
    if (orgMembershipsError) {
      console.error('Failed to fetch organization memberships:', orgMembershipsError)
      return new Response(JSON.stringify({ error: 'Failed to verify organization access' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const requestedOrgId = typeof body?.organization_id === 'string'
      ? body.organization_id.trim()
      : undefined
    const matchingOrgMembership = requestedOrgId
      ? orgMemberships?.find((membership) => membership.organization_id === requestedOrgId)
      : orgMemberships?.[0]

    if (!isSystemAdmin && !matchingOrgMembership) {
      return new Response(JSON.stringify({ error: 'Organization admin or owner access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const email = body?.email?.trim()?.toLowerCase()
    const fullName = body?.full_name?.trim() || ''
    const orgRole = body?.role || 'member'

    if (!email) {
      return new Response(JSON.stringify({ error: 'Email is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Determine target org:
    // - Org owners/admins always invite to their own org
    // - System admins can specify org_id in body
    let targetOrgId: string
    if (matchingOrgMembership) {
      targetOrgId = matchingOrgMembership.organization_id
    } else if (isSystemAdmin && body?.organization_id) {
      targetOrgId = body.organization_id
    } else {
      return new Response(JSON.stringify({ error: 'Could not determine target organization' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Fetch org name for messaging
    const { data: org } = await adminClient
      .from('organizations')
      .select('name')
      .eq('id', targetOrgId)
      .maybeSingle()

    const siteUrl = Deno.env.get('SITE_URL') ?? 'https://factoriq.app'

    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
      email,
      {
        redirectTo: `${siteUrl}/auth`,
        data: {
          full_name: fullName,
          organization_id: targetOrgId,
          organization_name: org?.name ?? '',
          invited_by: caller.id,
        },
      }
    )

    let newUserId: string | undefined
    let alreadyExisted = false

    if (inviteError) {
      const isExisting = inviteError.message?.includes('already been registered') || inviteError.message?.includes('already exists')
      if (!isExisting) {
        console.error('Invite error:', inviteError)
        return new Response(JSON.stringify({ error: inviteError.message || 'Failed to send invite' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // User already exists — look them up and add to org without re-inviting
      const { data: { users }, error: listError } = await adminClient.auth.admin.listUsers()
      if (listError) {
        return new Response(JSON.stringify({ error: 'Failed to look up existing user' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      const existingUser = users.find(u => u.email?.toLowerCase() === email)
      if (!existingUser) {
        return new Response(JSON.stringify({ error: 'User not found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      newUserId = existingUser.id
      alreadyExisted = true
    } else {
      newUserId = inviteData.user?.id
    }

    if (!newUserId) {
      return new Response(JSON.stringify({ error: 'User creation failed' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Upsert profile
    const { error: profileError } = await adminClient
      .from('profiles')
      .upsert({ user_id: newUserId, full_name: fullName || email, organization_id: targetOrgId }, { onConflict: 'user_id' })
    if (profileError) console.error('Profile upsert error:', profileError)

    // Pre-create org membership
    const { error: memberError } = await adminClient
      .from('organization_members')
      .upsert({ organization_id: targetOrgId, user_id: newUserId, role: orgRole }, { onConflict: 'organization_id,user_id' })
    if (memberError) console.error('Member insert error:', memberError)

    return new Response(JSON.stringify({
      data: {
        user_id: newUserId,
        email,
        organization_id: targetOrgId,
        organization_name: org?.name ?? '',
        message: alreadyExisted
          ? `${email} already has an account and has been added to ${org?.name ?? 'the organization'}.`
          : `Invitation sent to ${email}. They will be added to ${org?.name ?? 'the organization'} once they accept.`,
      }
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error) {
    console.error('invite-user error:', error)
    return new Response(JSON.stringify({ error: 'An unexpected error occurred' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
