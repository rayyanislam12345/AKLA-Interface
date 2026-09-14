-- Search every part of legacy large documents without an oversized tsvector.
create table public.document_search_chunks (
  source_document_id uuid not null references public.documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  search_vector tsvector generated always as (to_tsvector('simple'::regconfig, content)) stored,
  primary key(source_document_id,chunk_index)
);
alter table public.document_search_chunks enable row level security;
create policy "Read searchable documents through source access" on public.document_search_chunks for select
using (public.is_firm_member(auth.uid()) and exists(select 1 from public.documents d join public.matters m on m.id=d.matter_id where d.id=source_document_id));
create index document_search_chunks_fts_idx on public.document_search_chunks using gin(search_vector);
create index matter_notes_search_idx on public.matter_notes using gin(to_tsvector('simple'::regconfig,content));
create index matter_tasks_search_idx on public.matter_tasks using gin(to_tsvector('simple'::regconfig,title));
create index document_versions_storage_search_idx on public.document_versions(storage_path);

create function public.refresh_document_search() returns trigger language plpgsql security definer set search_path=public as $$
begin
  delete from document_search_chunks where source_document_id=new.id;
  if new.matter_id is not null and length(coalesce(new.content,'')) > 0 then
    insert into document_search_chunks(source_document_id,chunk_index,content)
    select new.id, n, substring(new.content from n*11500+1 for 12000)
    from generate_series(0,(length(new.content)-1)/11500) n;
  end if;
  return new;
end;
$$;
create trigger document_search_refresh after insert or update of content,matter_id on public.documents for each row execute function public.refresh_document_search();
insert into public.document_search_chunks(source_document_id,chunk_index,content)
select d.id,n,substring(d.content from n*11500+1 for 12000)
from public.documents d cross join lateral generate_series(0,(length(d.content)-1)/11500) n
where d.matter_id is not null and length(coalesce(d.content,''))>0;

create function public.search_project_content(p_query text, p_matter_id uuid default null, p_kind text default 'all', p_all_versions boolean default false, p_limit integer default 25, p_offset integer default 0)
returns table(kind text,item_id uuid,matter_id uuid,matter_name text,title text,snippet text,document_id uuid,version_id uuid,version_number integer,storage_path text,file_name text,created_at timestamptz,rank real,total_count bigint,matched_in text)
language plpgsql stable security invoker set search_path=public as $$
declare q tsquery;
begin
  if not public.is_firm_member(auth.uid()) then raise exception 'Forbidden'; end if;
  if length(trim(p_query))<2 or length(p_query)>200 then return; end if;
  if p_kind not in ('all','document','note','task') then raise exception 'Invalid search type'; end if;
  q := websearch_to_tsquery('simple',p_query);
  if numnode(q)=0 then return; end if;
  return query
  with versions as (
    select v.*,m.id as project_id,m.name as project_name,md.title as document_title
    from document_versions v join matter_documents md on md.id=v.matter_document_id join matters m on m.id=md.matter_id
    where (p_matter_id is null or m.id=p_matter_id) and (p_all_versions or not exists(select 1 from document_versions newer where newer.matter_document_id=v.matter_document_id and newer.version_number>v.version_number))
  ), hits as (
    select 'document'::text as k,v.id as item,v.project_id as project,v.project_name as project_label,v.document_title as label,
      ts_headline('simple',coalesce(v.file_name,''),q,'StartSel=⟦,StopSel=⟧,MaxWords=45,MinWords=12') as excerpt,
      v.matter_document_id as doc,v.id as ver,v.version_number as vnum,v.storage_path as path,v.file_name as filename,v.created_at as dated,
      (1+ts_rank(to_tsvector('simple',v.document_title || ' ' || coalesce(v.file_name,'')),q))::real as score,'title'::text as location
    from versions v where p_kind in ('all','document') and to_tsvector('simple',v.document_title || ' ' || coalesce(v.file_name,'')) @@ q
    union all
    select 'document',v.id,v.project_id,v.project_name,v.document_title,
      ts_headline('simple',c.content,q,'StartSel=⟦,StopSel=⟧,MaxWords=45,MinWords=12'),v.matter_document_id,v.id,v.version_number,v.storage_path,v.file_name,v.created_at,
      ts_rank(c.search_vector,q),'text'
    from document_search_chunks c join documents d on d.id=c.source_document_id join versions v on v.storage_path=d.metadata->>'storage_path' and v.project_id=d.matter_id
    where p_kind in ('all','document') and c.search_vector @@ q
    union all
    select 'note',n.id,m.id,m.name,'Project note',ts_headline('simple',n.content,q,'StartSel=⟦,StopSel=⟧,MaxWords=45,MinWords=12'),null::uuid,null::uuid,null::integer,null::text,null::text,n.created_at,ts_rank(to_tsvector('simple',n.content),q),'text'
    from matter_notes n join matters m on m.id=n.matter_id
    where p_kind in ('all','note') and (p_matter_id is null or m.id=p_matter_id) and to_tsvector('simple',n.content) @@ q
    union all
    select 'task',t.id,m.id,m.name,t.title,'Status: '||replace(t.status::text,'_',' ')||coalesce(' · Due '||t.due_date::text,''),null::uuid,null::uuid,null::integer,null::text,null::text,t.created_at,ts_rank(to_tsvector('simple',t.title),q),'title'
    from matter_tasks t join matters m on m.id=t.matter_id
    where p_kind in ('all','task') and (p_matter_id is null or m.id=p_matter_id) and to_tsvector('simple',t.title) @@ q
  ), dedup as (
    select distinct on(h.k,h.item) h.* from hits h order by h.k,h.item,h.score desc,h.location
  )
  select h.k,h.item,h.project,h.project_label,h.label,h.excerpt,h.doc,h.ver,h.vnum,h.path,h.filename,h.dated,h.score,count(*) over(),h.location
  from dedup h order by h.score desc,h.dated desc,h.item
  limit greatest(1,least(coalesce(p_limit,25),50)) offset greatest(0,least(coalesce(p_offset,0),10000));
end;
$$;
revoke all on function public.search_project_content(text,uuid,text,boolean,integer,integer) from public;
grant execute on function public.search_project_content(text,uuid,text,boolean,integer,integer) to authenticated;
