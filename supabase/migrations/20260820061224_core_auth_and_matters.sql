-- Extensions
create extension if not exists vector;

-- Roles
create type public.app_role as enum ('admin', 'partner', 'associate', 'paralegal');

-- Shared trigger fn for updated_at columns
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Lawyer directory (one row per auth.users row)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger update_profiles_updated_at
before update on public.profiles
for each row execute function public.update_updated_at_column();

-- App-level roles
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;

create or replace function public.is_firm_member(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = _user_id)
$$;

-- Auto-create a profile when someone signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;

create policy "Firm members can view all profiles"
on public.profiles for select
using (public.is_firm_member(auth.uid()));

create policy "Users can update their own profile"
on public.profiles for update
using (auth.uid() = id);

create policy "Firm members can view roles"
on public.user_roles for select
using (public.is_firm_member(auth.uid()));

create policy "Admins manage roles"
on public.user_roles for all
using (public.has_role(auth.uid(), 'admin'))
with check (public.has_role(auth.uid(), 'admin'));

-- Clients
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger update_clients_updated_at
before update on public.clients
for each row execute function public.update_updated_at_column();

-- Matters (transactions/engagements)
create table public.matters (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete set null,
  name text not null,
  sector text,
  matter_type text,
  status text not null default 'active',
  lead_partner_id uuid references public.profiles(id),
  opened_date date not null default current_date,
  target_close_date date,
  description text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger update_matters_updated_at
before update on public.matters
for each row execute function public.update_updated_at_column();

create index matters_client_id_idx on public.matters(client_id);

-- Matter stage checklist
create table public.matter_stages (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  status text not null default 'not_started',
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index matter_stages_matter_id_idx on public.matter_stages(matter_id);

-- Counterparties per matter
create table public.matter_parties (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  name text not null,
  role text not null,
  contact_info text,
  created_at timestamptz not null default now()
);

create index matter_parties_matter_id_idx on public.matter_parties(matter_id);

alter table public.clients enable row level security;
alter table public.matters enable row level security;
alter table public.matter_stages enable row level security;
alter table public.matter_parties enable row level security;

create policy "Firm members can view clients" on public.clients for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can manage clients" on public.clients for insert with check (public.is_firm_member(auth.uid()));
create policy "Firm members can update clients" on public.clients for update using (public.is_firm_member(auth.uid()));
create policy "Partners and admins can delete clients" on public.clients for delete using (public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'partner'));

create policy "Firm members can view matters" on public.matters for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can create matters" on public.matters for insert with check (public.is_firm_member(auth.uid()));
create policy "Firm members can update matters" on public.matters for update using (public.is_firm_member(auth.uid()));
create policy "Partners and admins can delete matters" on public.matters for delete using (public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'partner'));

create policy "Firm members can view matter stages" on public.matter_stages for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can manage matter stages" on public.matter_stages for all using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));

create policy "Firm members can view matter parties" on public.matter_parties for select using (public.is_firm_member(auth.uid()));
create policy "Firm members can manage matter parties" on public.matter_parties for all using (public.is_firm_member(auth.uid())) with check (public.is_firm_member(auth.uid()));
