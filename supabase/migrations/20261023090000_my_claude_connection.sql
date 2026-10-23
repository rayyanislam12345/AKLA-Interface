-- The "Use with Claude" page shows a lawyer whether their own Claude is
-- connected to the Hub. connector_tokens has no select policy (only the
-- connector reads it), so this answers for the caller alone and returns no
-- token or hash: when the current connection was made, when it was last
-- used, and whether it may save.
--
-- A connection is live while one of its refresh tokens is neither revoked,
-- rotated nor expired. Safe to run more than once. Reversal:
--   drop function if exists public.my_claude_connection();

create or replace function public.my_claude_connection()
returns table (connected_at timestamptz, last_used_at timestamptz, can_save boolean)
language sql
stable
security definer
set search_path = public
as $$
  with live as (
    select family_id, scope
      from public.connector_tokens
     where user_id = auth.uid()
       and kind = 'refresh'
       and revoked_at is null
       and rotated_at is null
       and expires_at > now()
  )
  select min(t.created_at),
         max(t.last_used_at),
         bool_or(live.scope like '%hub:write%')
    from public.connector_tokens t
    join live on live.family_id = t.family_id
   where t.user_id = auth.uid()
  having count(*) > 0;
$$;

revoke all on function public.my_claude_connection() from public, anon;
grant execute on function public.my_claude_connection() to authenticated;

comment on function public.my_claude_connection() is
  'The caller''s own live claude.ai connection: when made, last used, whether it may save. No tokens. For the Use with Claude page.';
