create table public.matter_notes (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  author_id uuid references auth.users(id),
  content text not null,
  created_at timestamptz not null default now()
);

create index matter_notes_matter_id_idx on public.matter_notes(matter_id);

create type public.task_status as enum ('open', 'in_progress', 'done');

create table public.matter_tasks (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  title text not null,
  assignee_id uuid references public.profiles(id),
  due_date date,
  status public.task_status not null default 'open',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger update_matter_tasks_updated_at
before update on public.matter_tasks
for each row execute function public.update_updated_at_column();

create index matter_tasks_matter_id_idx on public.matter_tasks(matter_id);

create table public.ai_chat_threads (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid references public.matters(id) on delete cascade,
  title text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.ai_chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.ai_chat_threads(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create index ai_chat_messages_thread_id_idx on public.ai_chat_messages(thread_id);

create table public.support_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  subject text not null,
  message text not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

alter table public.matter_notes enable row level security;
alter table public.matter_tasks enable row level security;
alter table public.ai_chat_threads enable row level security;
alter table public.ai_chat_messages enable row level security;
alter table public.support_requests enable row level security;

create policy "Firm members can view matter notes" on public.matter_notes for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can create matter notes" on public.matter_notes for insert with check (public.is_firm_member(auth.uid()));

create policy "Firm members can view matter tasks" on public.matter_tasks for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can manage matter tasks" on public.matter_tasks for all using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));

create policy "Firm members can view chat threads" on public.ai_chat_threads for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can create chat threads" on public.ai_chat_threads for insert with check (public.is_firm_member(auth.uid()));

create policy "Firm members can view chat messages" on public.ai_chat_messages for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can create chat messages" on public.ai_chat_messages for insert with check (public.is_firm_member(auth.uid()));

create policy "Users can view their own support requests" on public.support_requests for select using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'));
create policy "Users can create support requests" on public.support_requests for insert with check (auth.uid() = user_id);
create policy "Admins can update support requests" on public.support_requests for update using (public.has_role(auth.uid(), 'admin'));

-- Storage
insert into storage.buckets (id, name, public)
values ('matter-documents', 'matter-documents', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('precedent-library', 'precedent-library', false)
on conflict (id) do nothing;

create policy "Firm members can read matter documents bucket"
on storage.objects for select
using (bucket_id = 'matter-documents' and public.is_firm_member(auth.uid()));

create policy "Firm members can write matter documents bucket"
on storage.objects for insert
with check (bucket_id = 'matter-documents' and public.is_firm_member(auth.uid()));

create policy "Firm members can update matter documents bucket"
on storage.objects for update
using (bucket_id = 'matter-documents' and public.is_firm_member(auth.uid()));

create policy "Firm members can delete matter documents bucket"
on storage.objects for delete
using (bucket_id = 'matter-documents' and public.is_firm_member(auth.uid()));

create policy "Firm members can read precedent library bucket"
on storage.objects for select
using (bucket_id = 'precedent-library' and public.is_firm_member(auth.uid()));

create policy "Firm members can write precedent library bucket"
on storage.objects for insert
with check (bucket_id = 'precedent-library' and public.is_firm_member(auth.uid()));

create policy "Firm members can update precedent library bucket"
on storage.objects for update
using (bucket_id = 'precedent-library' and public.is_firm_member(auth.uid()));

create policy "Firm members can delete precedent library bucket"
on storage.objects for delete
using (bucket_id = 'precedent-library' and public.is_firm_member(auth.uid()));
