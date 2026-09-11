-- Keep immutable template snapshots, including the existing approved uploads.
create table public.document_template_versions (
  id uuid primary key default gen_random_uuid(),
  document_type_id uuid not null references public.document_types(id),
  storage_path text not null unique,
  filename text,
  content_html text,
  format_rules text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.document_template_versions enable row level security;
create policy "Firm members read standard history" on public.document_template_versions for select using (public.is_firm_member(auth.uid()));
insert into public.document_template_versions(document_type_id,storage_path,filename,content_html,format_rules,created_by)
select document_type_id,storage_path,filename,content_html,format_rules,updated_by from public.document_type_templates where storage_path is not null on conflict do nothing;
create function public.snapshot_document_template() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.storage_path is not null then
    insert into document_template_versions(document_type_id,storage_path,filename,content_html,format_rules,created_by)
    values(new.document_type_id,new.storage_path,new.filename,new.content_html,new.format_rules,new.updated_by) on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger document_template_snapshot after insert or update on public.document_type_templates for each row execute function public.snapshot_document_template();

-- Allocate versions under a document lock and refuse edits based on stale versions.
create function public.save_ai_document(p_matter_id uuid, p_document_type_id uuid, p_document_id uuid, p_create_new boolean,
  p_expected_version_id uuid, p_title text, p_storage_path text, p_file_stem text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_latest uuid; v_number integer; v_version uuid; v_name text;
begin
  if not public.is_firm_member(auth.uid()) then raise exception 'Forbidden'; end if;
  if p_storage_path not like p_matter_id::text || '/' || p_document_id::text || '/%' or p_storage_path like '%..%' then raise exception 'Invalid document storage path'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text, 0));
  if p_create_new then
    insert into matter_documents(id,matter_id,document_type_id,title,status,created_by)
    values(p_document_id,p_matter_id,p_document_type_id,p_title,'drafting',auth.uid());
  elsif not exists(select 1 from matter_documents where id=p_document_id and matter_id=p_matter_id and document_type_id=p_document_type_id) then
    raise exception 'Document does not belong to this project and type';
  end if;
  select id,version_number into v_latest,v_number from document_versions where matter_document_id=p_document_id order by version_number desc limit 1;
  if not p_create_new and (p_expected_version_id is null or v_latest is distinct from p_expected_version_id) then
    raise exception 'A newer document version exists. Reopen the latest version before saving these edits.';
  end if;
  v_number := coalesce(v_number,0)+1;
  v_name := p_file_stem || '-v' || v_number::text || '.docx';
  insert into document_versions(matter_document_id,version_number,storage_path,file_name,is_ai_generated,uploaded_by)
  values(p_document_id,v_number,p_storage_path,v_name,true,auth.uid()) returning id into v_version;
  return jsonb_build_object('matterDocumentId',p_document_id,'versionId',v_version,'versionNumber',v_number,'fileName',v_name);
end;
$$;
revoke all on function public.save_ai_document(uuid,uuid,uuid,boolean,uuid,text,text,text) from public;
grant execute on function public.save_ai_document(uuid,uuid,uuid,boolean,uuid,text,text,text) to authenticated;
