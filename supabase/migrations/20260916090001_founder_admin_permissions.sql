-- Keep `has_role(..., 'admin')` as the single admin capability check so every
-- existing admin-gated RLS policy grants founders exactly the same access.
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = _user_id
      and (
        role = _role
        or (
          _role = 'admin'::public.app_role
          and role = 'founder'::public.app_role
        )
      )
  )
$$;
