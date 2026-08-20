revoke execute on function public.has_role(uuid, public.app_role) from public;
revoke execute on function public.is_firm_member(uuid) from public;

grant execute on function public.has_role(uuid, public.app_role) to authenticated;
grant execute on function public.is_firm_member(uuid) to authenticated;
