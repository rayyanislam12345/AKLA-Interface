-- Maps whatsapp-dashboard's own local accounts (bcrypt-based, unrelated to
-- Supabase Auth) to firm member profiles. Admin-maintained, no auto-discovery.
create table public.whatsapp_account_links (
  id uuid primary key default gen_random_uuid(),
  whatsapp_user_id text not null unique,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.whatsapp_account_links enable row level security;

create policy "Firm members can view whatsapp account links"
on public.whatsapp_account_links for select
using (public.is_firm_member(auth.uid()));

create policy "Admins manage whatsapp account links"
on public.whatsapp_account_links for all
using (public.has_role(auth.uid(), 'admin'))
with check (public.has_role(auth.uid(), 'admin'));

-- LLM-inferred "matters" from a lawyer's WhatsApp activity. Unlinked rows are
-- private to the capturing lawyer; linking to a real `matters` row is an
-- affirmative act of sharing that makes the row firm-visible, mirroring the
-- rest of the app's no-per-matter-ACL model.
create table public.whatsapp_matters (
  id uuid primary key default gen_random_uuid(),
  source_user_id text not null,
  source_matter_id text not null,
  owner_id uuid references public.profiles(id) on delete set null,
  matter_id uuid references public.matters(id) on delete set null,
  name text not null,
  aliases text[] not null default '{}',
  summary text not null default '',
  detailed_summary text not null default '',
  chat_history jsonb not null default '{}'::jsonb,
  chats text[] not null default '{}',
  message_count int not null default 0,
  last_active_at timestamptz,
  matter_created_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (source_user_id, source_matter_id)
);

create index whatsapp_matters_owner_id_idx on public.whatsapp_matters(owner_id);
create index whatsapp_matters_matter_id_idx on public.whatsapp_matters(matter_id);

create table public.whatsapp_documents (
  id uuid primary key default gen_random_uuid(),
  whatsapp_matter_id uuid not null references public.whatsapp_matters(id) on delete cascade,
  source_user_id text not null,
  source_document_id text not null,
  owner_id uuid references public.profiles(id) on delete set null,
  filename text not null,
  mimetype text,
  chat_name text,
  sender text,
  message_at timestamptz,
  kind text,
  storage_path text not null,
  synced_at timestamptz not null default now(),
  unique (source_user_id, source_document_id)
);

create index whatsapp_documents_matter_idx on public.whatsapp_documents(whatsapp_matter_id);

alter table public.whatsapp_matters enable row level security;

create policy "Owner or firm (if linked) can view whatsapp matters"
on public.whatsapp_matters for select
using (
  auth.uid() = owner_id
  or (matter_id is not null and public.is_firm_member(auth.uid()))
);

create policy "Owner or firm (if linked) can update whatsapp matters"
on public.whatsapp_matters for update
using (
  auth.uid() = owner_id
  or (matter_id is not null and public.is_firm_member(auth.uid()))
)
with check (public.is_firm_member(auth.uid()));

-- Authenticated users may only ever change matter_id (the link) — every
-- other column is sync-owned, written only by the service-role sync job.
revoke update on public.whatsapp_matters from authenticated;
grant update (matter_id) on public.whatsapp_matters to authenticated;

-- No insert/delete policy for authenticated — only the sync job writes full rows.

alter table public.whatsapp_documents enable row level security;

create policy "Owner or firm (if parent linked) can view whatsapp documents"
on public.whatsapp_documents for select
using (
  auth.uid() = owner_id
  or exists (
    select 1 from public.whatsapp_matters wm
    where wm.id = whatsapp_documents.whatsapp_matter_id
      and wm.matter_id is not null
      and public.is_firm_member(auth.uid())
  )
);

-- No write policy for authenticated — documents are sync-only, never user-edited.

-- Defense-in-depth: matter_id is a hard DB guarantee against being clobbered
-- by the sync job, not just a "the payload happens not to include it" convention.
create or replace function public.protect_whatsapp_matter_link()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    new.matter_id := old.matter_id;
  end if;
  return new;
end;
$$;

create trigger whatsapp_matters_protect_link
before update on public.whatsapp_matters
for each row execute function public.protect_whatsapp_matter_link();

insert into storage.buckets (id, name, public)
values ('whatsapp-documents', 'whatsapp-documents', false)
on conflict (id) do nothing;

-- Gated through the whatsapp_documents row for a given object path (every
-- document already has one with a known path) rather than folder-prefix
-- conventions like mandate-documents uses.
create or replace function public.can_access_whatsapp_document(_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.whatsapp_documents wd
    join public.whatsapp_matters wm on wm.id = wd.whatsapp_matter_id
    where wd.storage_path = _path
      and (wd.owner_id = auth.uid() or (wm.matter_id is not null and public.is_firm_member(auth.uid())))
  )
$$;

revoke execute on function public.can_access_whatsapp_document(text) from anon, public;
grant execute on function public.can_access_whatsapp_document(text) to authenticated;

create policy "Owner or firm (if linked) can read whatsapp documents bucket"
on storage.objects for select
using (bucket_id = 'whatsapp-documents' and public.can_access_whatsapp_document(name));

-- No write policy for authenticated — only the sync job uploads.
