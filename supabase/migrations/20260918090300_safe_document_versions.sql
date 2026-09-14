alter table public.matter_documents add column if not exists last_version_number integer not null default 0;
update public.matter_documents m set last_version_number = coalesce((select max(version_number) from public.document_versions v where v.matter_document_id=m.id),0);
alter table public.document_versions add column if not exists indexing_status text not null default 'unknown' check (indexing_status in ('unknown','pending','indexed','failed','unsupported'));

-- Allocate versions under a document lock and refuse edits based on stale versions.
create or replace function public.save_document_version(p_matter_id uuid, p_document_type_id uuid, p_document_id uuid, p_create_new boolean,
  p_expected_version_id uuid, p_title text, p_storage_path text, p_file_stem text, p_is_ai_generated boolean default true, p_extension text default 'docx')
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_latest uuid; v_number integer; v_version uuid; v_name text;
begin
  if not public.is_firm_member(auth.uid()) then raise exception 'Forbidden'; end if;
  if not exists(select 1 from public.matters where id=p_matter_id) then raise exception 'Project is unavailable'; end if;
  if p_storage_path not like p_matter_id::text || '/' || p_document_id::text || '/%' or p_storage_path like '%..%' then raise exception 'Invalid document storage path'; end if;
  if p_file_stem is null or length(p_file_stem) > 200 or p_extension !~ '^[a-zA-Z0-9]{1,10}$' then raise exception 'Invalid file name'; end if;
  if not exists(select 1 from storage.objects where bucket_id='matter-documents' and name=p_storage_path) then raise exception 'The uploaded file is unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text, 0));
  -- Retrying a request with the same staged upload returns its committed version.
  select v.id,v.version_number,v.file_name into v_version,v_number,v_name from document_versions v join matter_documents m on m.id=v.matter_document_id
  where v.storage_path=p_storage_path and m.id=p_document_id and m.matter_id=p_matter_id;
  if v_version is not null then return jsonb_build_object('matterDocumentId',p_document_id,'versionId',v_version,'versionNumber',v_number,'fileName',v_name); end if;
  if p_create_new then
    insert into matter_documents(id,matter_id,document_type_id,title,status,created_by)
    values(p_document_id,p_matter_id,p_document_type_id,p_title,'drafting',auth.uid());
  elsif not exists(select 1 from matter_documents where id=p_document_id and matter_id=p_matter_id and document_type_id is not distinct from p_document_type_id) then
    raise exception 'Document does not belong to this project and type';
  end if;
  select id,version_number into v_latest,v_number from document_versions where matter_document_id=p_document_id order by version_number desc limit 1;
  if not p_create_new and (v_latest is distinct from p_expected_version_id) then
    raise exception 'A newer document version exists. Reopen the latest version before saving these edits.';
  end if;
  select greatest(last_version_number, coalesce(v_number,0))+1 into v_number from matter_documents where id=p_document_id;
  update matter_documents set last_version_number=v_number where id=p_document_id;
  v_name := p_file_stem || '-v' || v_number::text || '.' || lower(p_extension);
  insert into document_versions(matter_document_id,version_number,storage_path,file_name,is_ai_generated,uploaded_by,indexing_status)
  values(p_document_id,v_number,p_storage_path,v_name,p_is_ai_generated,auth.uid(),'pending') returning id into v_version;
  return jsonb_build_object('matterDocumentId',p_document_id,'versionId',v_version,'versionNumber',v_number,'fileName',v_name);
end;
$$;
revoke all on function public.save_document_version(uuid,uuid,uuid,boolean,uuid,text,text,text,boolean,text) from public;
grant execute on function public.save_document_version(uuid,uuid,uuid,boolean,uuid,text,text,text,boolean,text) to authenticated;

-- Existing deployed clients retain the same API with the stronger implementation.
create or replace function public.save_ai_document(p_matter_id uuid, p_document_type_id uuid, p_document_id uuid, p_create_new boolean,
  p_expected_version_id uuid, p_title text, p_storage_path text, p_file_stem text)
returns jsonb language sql security invoker set search_path=public as $$
  select public.save_document_version(p_matter_id,p_document_type_id,p_document_id,p_create_new,p_expected_version_id,p_title,p_storage_path,p_file_stem,true,'docx');
$$;
