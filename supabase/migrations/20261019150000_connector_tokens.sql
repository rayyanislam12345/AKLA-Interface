-- The claude.ai connector's OAuth records, 19 Oct 2026.
--
-- A lawyer adds "AKLA Hub" to their own claude.ai (Customize > Connectors,
-- https://aklachat.duckdns.org/mcp). claude.ai registers itself as an OAuth
-- client, sends the lawyer to the connector's sign-in page (their Hub email,
-- password and authenticator code), and receives the connector's OWN opaque
-- tokens in return. No Supabase session or JWT is ever handed to claude.ai:
-- the sign-in happens on the server (chat-service/connector/signIn.js), the
-- Supabase session is discarded at once, and only the user id is kept, on
-- the token row. Every tool call then runs with the service role and applies
-- the Hub's rules for that user (an approved firm member sees projects,
-- documents, the law library and precedents; nothing else).
--
-- Three tables, written only by the connector (service role):
--
--   connector_clients      one row per claude.ai registration (dynamic client
--                          registration, RFC 7591): id, redirect URIs, the
--                          secret's hash when the client has one.
--   connector_auth_codes   authorization codes, hashed; single use; five
--                          minutes; the PKCE challenge the code was issued
--                          against (OAuth 2.1: S256 is required).
--   connector_tokens       access tokens (one hour) and refresh tokens
--                          (thirty days, rotated on every use), hashed
--                          (SHA-256, base64url) with their expiry, the user
--                          they belong to and the family they were issued in
--                          (one family per sign-in; revoking one revokes all).
--                          rotated_at marks a used refresh token; revoked_at
--                          marks one withdrawn.
--
-- The plain tokens are never stored: a copy of the database cannot be used
-- to call the connector.
--
-- Admin notes (also in docs/claude-ai-connector.md):
--   revoke one person's access (they sign in again next time):
--     update public.connector_tokens set revoked_at = now()
--      where revoked_at is null and user_id = (select id from auth.users where email = 'name@akla.com.pk');
--   prune what has expired:
--     select public.connector_prune();
--
-- Safe to run more than once. Reversal:
--   drop function if exists public.connector_prune();
--   drop table if exists public.connector_tokens;
--   drop table if exists public.connector_auth_codes;
--   drop table if exists public.connector_clients;

set lock_timeout = '10s';

create table if not exists public.connector_clients (
  id text primary key,
  client_name text,
  client_secret_hash text,
  token_endpoint_auth_method text not null default 'none',
  redirect_uris text[] not null,
  grant_types text[] not null default array['authorization_code', 'refresh_token'],
  client_uri text,
  software_id text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
comment on table public.connector_clients is
  'OAuth clients registered with the claude.ai connector (chat-service/connector). Written by the connector only.';

create table if not exists public.connector_auth_codes (
  code_hash text primary key,
  client_id text not null references public.connector_clients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  scope text not null default 'hub:read',
  resource text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
comment on table public.connector_auth_codes is
  'Authorization codes the connector issued after a sign-in, hashed; single use, five minutes.';

create table if not exists public.connector_tokens (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('access', 'refresh')),
  token_hash text not null unique,
  client_id text not null references public.connector_clients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id uuid not null,
  scope text not null default 'hub:read',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  rotated_at timestamptz,
  last_used_at timestamptz
);
-- A refresh token that was used is "rotated", not revoked: the connector
-- rotates it in one conditional update and allows a 60-second grace window
-- for a retried or concurrent refresh; a later reuse revokes the family.
alter table public.connector_tokens add column if not exists rotated_at timestamptz;
comment on table public.connector_tokens is
  'The connector''s own access and refresh tokens, hashed, with expiry. family_id groups the tokens of one sign-in. rotated_at: a refresh token superseded by its successor; revoked_at: withdrawn. Written by the connector only.';

create index if not exists connector_tokens_user_idx on public.connector_tokens (user_id) where revoked_at is null;
create index if not exists connector_tokens_family_idx on public.connector_tokens (family_id);
create index if not exists connector_tokens_expires_idx on public.connector_tokens (expires_at);
create index if not exists connector_auth_codes_expires_idx on public.connector_auth_codes (expires_at);

-- Service role only: RLS on with no policies, and nothing granted to the
-- API roles. The connector holds the service key; the site never reads these.
alter table public.connector_clients enable row level security;
alter table public.connector_auth_codes enable row level security;
alter table public.connector_tokens enable row level security;
revoke all on public.connector_clients, public.connector_auth_codes, public.connector_tokens from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.connector_clients, public.connector_auth_codes, public.connector_tokens from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.connector_clients, public.connector_auth_codes, public.connector_tokens from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.connector_clients, public.connector_auth_codes, public.connector_tokens to service_role;
  end if;
end $$;

-- Housekeeping: codes and tokens past their time. Returns how many rows went.
create or replace function public.connector_prune()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; m integer := 0;
begin
  delete from public.connector_auth_codes where expires_at < now() - interval '1 day';
  get diagnostics n = row_count;
  delete from public.connector_tokens
   where expires_at < now() - interval '7 days'
      or (revoked_at is not null and revoked_at < now() - interval '30 days')
      or (rotated_at is not null and rotated_at < now() - interval '1 day');
  get diagnostics m = row_count;
  return n + m;
end;
$$;
revoke all on function public.connector_prune() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.connector_prune() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.connector_prune() from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.connector_prune() to service_role; end if;
end $$;
