-- The claude.ai connector's write foundation (slice 2.0 of
-- docs/connector-expansion-plan-2026-10-19.md): the site's save as a
-- function the connector can call as the signed-in lawyer, and the record
-- of every write the connector makes.
--
-- Why a twin: save_document_version (20260918090300) is SECURITY INVOKER,
-- checks is_firm_member(auth.uid()) and stamps created_by / uploaded_by from
-- auth.uid(). The connector runs under the service role, where auth.uid()
-- is null, so the member check raises 'Forbidden' and the stamps would be
-- empty. save_document_version_as takes the user's id as its first
-- parameter instead; the same body otherwise (the storage-path shape, the
-- advisory lock per document, the staged-upload idempotency, the expected-
-- version check, the version number from last_version_number). Only
-- service_role may call it. The site's save_document_version keeps its
-- signature and becomes a thin wrapper passing auth.uid(), so the two share
-- one implementation (the pattern of 20261020100000_search_project_content_as);
-- src/lib/documentSave.ts, saveDraftToMatter.ts and saveFileToProject.ts,
-- and save_ai_document, call it exactly as before.
--
-- connector_actions is the record: who, which tool, which project, document
-- and version, the label, the outcome, when. NEVER the document's text, and
-- no column for it. RLS on with no policies and nothing granted to the API
-- roles; the connector holds the service key and only inserts and reads.
-- The caps (30 writes an hour, 200 a day per person) are counted from this
-- table, so a restart or a deploy does not reset them; only the rows that
-- changed something count (outcome saved or done), so a run of refused or
-- failed attempts does not lock a person out.
--
-- Applied by hand before slice 2's tools are deployed (docs/claude-ai-connector.md,
-- Deploying). Safe to run twice. Confirm with
--   select has_function_privilege('service_role', 'public.save_document_version_as(uuid,uuid,uuid,uuid,boolean,uuid,text,text,text,boolean,text,text)', 'execute');

-- The version label the site writes after a save (src/lib/documentSave.ts
-- setVersionLabel); present in production, declared here so the function
-- below can write it in the same transaction wherever this runs.
alter table public.document_versions add column if not exists label text;

-- ------------------------------------------------------- the save, as a user
create or replace function public.save_document_version_as(p_user_id uuid, p_matter_id uuid, p_document_type_id uuid, p_document_id uuid, p_create_new boolean,
  p_expected_version_id uuid, p_title text, p_storage_path text, p_file_stem text, p_is_ai_generated boolean default true, p_extension text default 'docx', p_label text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_latest uuid; v_number integer; v_version uuid; v_name text;
begin
  if p_user_id is null or not public.is_firm_member(p_user_id) then raise exception 'Forbidden'; end if;
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
    values(p_document_id,p_matter_id,p_document_type_id,p_title,'drafting',p_user_id);
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
  -- The AFTER INSERT trigger document_versions_enqueue_index (20261017090000)
  -- queues the index worker for this row; nothing else is needed.
  insert into document_versions(matter_document_id,version_number,storage_path,file_name,is_ai_generated,uploaded_by,indexing_status,label)
  values(p_document_id,v_number,p_storage_path,v_name,p_is_ai_generated,p_user_id,'pending',nullif(left(p_label,200),'')) returning id into v_version;
  return jsonb_build_object('matterDocumentId',p_document_id,'versionId',v_version,'versionNumber',v_number,'fileName',v_name);
end;
$$;
revoke all on function public.save_document_version_as(uuid,uuid,uuid,uuid,boolean,uuid,text,text,text,boolean,text,text) from public, anon, authenticated;
grant execute on function public.save_document_version_as(uuid,uuid,uuid,uuid,boolean,uuid,text,text,text,boolean,text,text) to service_role;

-- The site's function, now a wrapper. It is security definer only so that
-- it may call the function above, which authenticated cannot call directly;
-- auth.uid() is read from the request's JWT, so it is still the browser's
-- user that is checked and stamped. Same signature, same result, same
-- errors; the label stays the site's own update after the save.
create or replace function public.save_document_version(p_matter_id uuid, p_document_type_id uuid, p_document_id uuid, p_create_new boolean,
  p_expected_version_id uuid, p_title text, p_storage_path text, p_file_stem text, p_is_ai_generated boolean default true, p_extension text default 'docx')
returns jsonb language sql security definer set search_path=public as $$
  select public.save_document_version_as(auth.uid(), p_matter_id, p_document_type_id, p_document_id, p_create_new, p_expected_version_id, p_title, p_storage_path, p_file_stem, p_is_ai_generated, p_extension, null);
$$;
revoke all on function public.save_document_version(uuid,uuid,uuid,boolean,uuid,text,text,text,boolean,text) from public, anon;
grant execute on function public.save_document_version(uuid,uuid,uuid,boolean,uuid,text,text,text,boolean,text) to authenticated;

-- ------------------------------------------------------ the record of writes
create table if not exists public.connector_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id text,
  tool text not null,
  project_id uuid,
  document_id uuid,
  version_id uuid,
  label text,
  outcome text not null default 'saved' check (outcome in ('saved', 'done', 'failed', 'refused')),
  created_at timestamptz not null default now()
);
comment on table public.connector_actions is
  'One row per write the claude.ai connector makes: who (user_id, the Hub account), which tool, which project, document and version, the version label, the outcome, when. Never the document''s text. The connector''s write caps (30 an hour, 200 a day per person) are counted here, from the rows whose outcome is saved or done. Written by the connector only.';

-- The caps: this person's rows in the last hour and day.
create index if not exists connector_actions_user_created_idx on public.connector_actions (user_id, created_at desc);

-- Service role only: RLS on with no policies, and nothing granted to the
-- API roles (the pattern of 20261019150000_connector_tokens.sql). Insert
-- and select only: the record is not edited or pruned from the connector.
alter table public.connector_actions enable row level security;
revoke all on public.connector_actions from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.connector_actions from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.connector_actions from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on public.connector_actions to service_role;
  end if;
end $$;
