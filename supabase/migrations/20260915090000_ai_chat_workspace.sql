-- Claude-style AI Workspace: many conversations per matter, attachments,
-- artifacts (drafts, memos, reviews produced in a conversation), and skills.
--
-- ai_chat_threads / ai_chat_messages predate this and were write-once: firm
-- members could create and read, never rename, pin, delete or edit — fine for
-- one implicit "Matter Q&A" thread, useless for a conversation list a lawyer
-- manages the way they manage chats on claude.ai.

alter table public.ai_chat_threads
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists last_message_at timestamptz,
  add column if not exists pinned boolean not null default false,
  add column if not exists archived boolean not null default false,
  -- The skill a conversation was started with (e.g. draft + document type),
  -- so the composer can restore it when the thread is reopened.
  add column if not exists skill jsonb;

create index if not exists ai_chat_threads_matter_recent_idx
  on public.ai_chat_threads(matter_id, pinned desc, last_message_at desc nulls last);

alter table public.ai_chat_messages
  -- attachments (bucket/path/name + cached extracted text), retrieval sources,
  -- the skill in force, artifact markers — everything about a message that
  -- isn't its text.
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_by uuid references auth.users(id);

create index if not exists ai_chat_messages_thread_created_idx
  on public.ai_chat_messages(thread_id, created_at);

-- Keep the sidebar ordering honest without trusting every writer to remember.
create or replace function public.touch_chat_thread_on_message()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.ai_chat_threads
     set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at),
         updated_at = now()
   where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists ai_chat_messages_touch_thread on public.ai_chat_messages;
create trigger ai_chat_messages_touch_thread
  after insert on public.ai_chat_messages
  for each row execute function public.touch_chat_thread_on_message();

-- Backfill for the threads that already exist.
update public.ai_chat_threads t
   set last_message_at = m.last_at
  from (select thread_id, max(created_at) as last_at from public.ai_chat_messages group by thread_id) m
 where m.thread_id = t.id and t.last_message_at is null;

create policy "Firm members can update chat threads"
  on public.ai_chat_threads for update
  using (public.is_firm_member(auth.uid()))
  with check (public.is_firm_member(auth.uid()));

create policy "Firm members can delete chat threads"
  on public.ai_chat_threads for delete
  using (public.is_firm_member(auth.uid()));

create policy "Firm members can update chat messages"
  on public.ai_chat_messages for update
  using (public.is_firm_member(auth.uid()))
  with check (public.is_firm_member(auth.uid()));

create policy "Firm members can delete chat messages"
  on public.ai_chat_messages for delete
  using (public.is_firm_member(auth.uid()));

-- Something a conversation produced that is more than a reply: a draft, a
-- memo, a review. It lives beside the message that created it and is what
-- the right-hand panel opens. Drafts are edited in place, so content is
-- mutable; the message that made it is not.
create table public.ai_artifacts (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.ai_chat_threads(id) on delete cascade,
  message_id uuid references public.ai_chat_messages(id) on delete set null,
  matter_id uuid references public.matters(id) on delete cascade,
  kind text not null check (kind in ('draft', 'memo', 'review')),
  title text not null,
  -- Markdown for draft/memo (same conventions draft-document uses, so
  -- lib/firmDocx.ts can export it); null for a review.
  content text,
  -- draft/memo: { documentTypeId, documentTypeName }
  -- review:     { documentVersionId, matterDocumentId, suggestionCount }
  data jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ai_artifacts_thread_idx on public.ai_artifacts(thread_id, created_at);

alter table public.ai_artifacts enable row level security;

create policy "Firm members can view artifacts"
  on public.ai_artifacts for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can create artifacts"
  on public.ai_artifacts for insert with check (public.is_firm_member(auth.uid()));
create policy "Firm members can update artifacts"
  on public.ai_artifacts for update using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
create policy "Firm members can delete artifacts"
  on public.ai_artifacts for delete using (public.is_firm_member(auth.uid()));

-- Custom skills: reusable instructions a lawyer can invoke from the composer,
-- the way claude.ai's skills work. Built-in skills (draft, verify, summarise)
-- live in code; this is the firm's own additions.
create table public.ai_skills (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  instructions text not null,
  -- Whether invoking it should produce a document artifact (memo/draft)
  -- rather than just a reply.
  produces_document boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_skills enable row level security;

create policy "Firm members can view skills"
  on public.ai_skills for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can create skills"
  on public.ai_skills for insert with check (public.is_firm_member(auth.uid()));
create policy "Firm members can update skills"
  on public.ai_skills for update using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
create policy "Firm members can delete skills"
  on public.ai_skills for delete using (public.is_firm_member(auth.uid()));

-- Files dropped into a conversation. Not matter documents (a lawyer may be
-- asking about something they haven't decided to file yet); "Save to matter"
-- copies one into matter-documents through the normal upload pipeline.
insert into storage.buckets (id, name, public)
values ('ai-chat-files', 'ai-chat-files', false)
on conflict (id) do nothing;

create policy "Firm members can read chat files bucket"
  on storage.objects for select using (bucket_id = 'ai-chat-files' and public.is_firm_member(auth.uid()));
create policy "Firm members can write chat files bucket"
  on storage.objects for insert with check (bucket_id = 'ai-chat-files' and public.is_firm_member(auth.uid()));
create policy "Firm members can update chat files bucket"
  on storage.objects for update using (bucket_id = 'ai-chat-files' and public.is_firm_member(auth.uid()));
create policy "Firm members can delete chat files bucket"
  on storage.objects for delete using (bucket_id = 'ai-chat-files' and public.is_firm_member(auth.uid()));
