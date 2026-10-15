import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const user='00000000-0000-0000-0000-000000000001';
const project='00000000-0000-0000-0000-000000000002';
const hidden='00000000-0000-0000-0000-000000000003';
const type='00000000-0000-0000-0000-000000000004';
async function database() {
 const db=new PGlite();
 await db.exec(`
 create schema auth; create schema storage; create role authenticated;
 create table auth.users(id uuid primary key); insert into auth.users values('${user}');
 create function auth.uid() returns uuid language sql stable as $$ select '${user}'::uuid $$;
 create function public.is_firm_member(uuid) returns boolean language sql stable as $$ select coalesce(current_setting('test.member',true),'true') <> 'false' $$;
 create table matters(id uuid primary key,name text);
 create table document_types(id uuid primary key,name text);
 create table matter_documents(id uuid primary key default gen_random_uuid(),matter_id uuid references matters(id),document_type_id uuid references document_types(id),title text,status text,created_by uuid);
 create table document_versions(id uuid primary key default gen_random_uuid(),matter_document_id uuid references matter_documents(id) on delete cascade,version_number integer,storage_path text,file_name text,is_ai_generated boolean,uploaded_by uuid,created_at timestamptz default now(),unique(matter_document_id,version_number));
 create table document_type_templates(document_type_id uuid primary key references document_types(id),storage_path text,filename text,content_html text,format_rules text,updated_by uuid);
 create table documents(id uuid primary key default gen_random_uuid(),matter_id uuid references matters(id),content text,metadata jsonb);
 create table matter_notes(id uuid primary key default gen_random_uuid(),matter_id uuid references matters(id),content text,created_at timestamptz default now());
 create table matter_tasks(id uuid primary key default gen_random_uuid(),matter_id uuid references matters(id),title text,status text,due_date date,created_at timestamptz default now());
 create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));
 insert into matters values('${project}','Visible project'),('${hidden}','Restricted project'); insert into document_types values('${type}','Agreement');
 alter table matters enable row level security;
 create policy visible_matters on matters for all using (id <> '${hidden}') with check(id <> '${hidden}');
 `);
 await db.exec(readFileSync('supabase/migrations/20260918090100_ai_document_integrity.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260918090300_safe_document_versions.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260918090200_project_search.sql','utf8'));
 // The change record, stubbed in its live shape (not-null version, the inline
 // four-value check) so the migration's drop/alter statements are exercised.
 await db.exec(`
 create type public.redline_status as enum ('pending','accepted','rejected');
 create table ai_chat_threads(id uuid primary key default gen_random_uuid(),matter_id uuid references matters(id),document_type_id uuid references document_types(id),created_by uuid);
 create table ai_chat_messages(id uuid primary key default gen_random_uuid(),thread_id uuid references ai_chat_threads(id) on delete cascade);
 create table ai_artifacts(id uuid primary key default gen_random_uuid(),thread_id uuid references ai_chat_threads(id) on delete cascade,kind text,title text,data jsonb not null default '{}'::jsonb);
 create table ai_review_runs(id uuid primary key default gen_random_uuid(),document_version_id uuid not null references document_versions(id) on delete cascade,status text not null default 'running' check (status in ('running','complete','failed')),passes jsonb not null default '{}'::jsonb,coverage jsonb not null default '{}'::jsonb,source_hash text,template_path text,error text,created_by uuid default auth.uid() references auth.users(id),created_at timestamptz not null default now());
 create table redline_suggestions(id uuid primary key default gen_random_uuid(),document_version_id uuid not null references document_versions(id) on delete cascade,clause_reference text,original_text text,suggested_text text,rationale text,status public.redline_status not null default 'pending',created_at timestamptz not null default now(),review_type text not null default 'content_conflicts' check (review_type in ('legal_clauses','formatting','content_conflicts','chat')),review_run_id uuid references ai_review_runs(id) on delete cascade);
 `);
 await db.exec(readFileSync('supabase/migrations/20261015090000_one_change_record.sql','utf8'));
 await db.exec('grant usage on schema public,auth,storage to authenticated; grant select,insert,update,delete on all tables in schema public,storage to authenticated;');
 return db;
}
async function staged(db,doc,path=randomUUID()+'.docx') {
 const storagePath=`${project}/${doc}/${path}`;
 await db.query('insert into storage.objects values($1,$2)',['matter-documents',storagePath]);
 return storagePath;
}
async function save(db,doc,path,{create=true,expected=null,matter=project}={}) {
 return (await db.query('select save_document_version($1,$2,$3,$4,$5,$6,$7,$8) result',[matter,type,doc,create,expected,'Agreement',path,'Agreement'])).rows[0].result;
}
test('safe saving is atomic, idempotent, refuses stale versions, and does not reuse deleted numbers', async () => {
 const db=await database();
 try {
  await db.exec('set role authenticated');
  const doc=randomUUID(),path=await staged(db,doc);
  const v1=await save(db,doc,path);
  assert.equal(v1.versionNumber,1);
  assert.deepEqual(await save(db,doc,path),v1);
  const paths=await Promise.all([staged(db,doc),staged(db,doc)]);
  const attempts=await Promise.allSettled(paths.map(p=>save(db,doc,p,{create:false,expected:v1.versionId})));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  assert.match(attempts.find(r=>r.status==='rejected').reason.message,/newer document version/);
  const v2=attempts.find(r=>r.status==='fulfilled').value;
  assert.equal(v2.versionNumber,2);
  await db.query('delete from document_versions where id=$1',[v2.versionId]);
  const v3=await save(db,doc,await staged(db,doc),{create:false,expected:v1.versionId});
  assert.equal(v3.versionNumber,3);
  await assert.rejects(save(db,doc,await staged(db,doc),{create:false,expected:v3.versionId,matter:hidden}),/Project is unavailable/);
  const hiddenDoc=randomUUID(),hiddenPath=`${hidden}/${hiddenDoc}/staged.docx`;
  await db.query('insert into storage.objects values($1,$2)',['matter-documents',hiddenPath]);
  await assert.rejects(save(db,hiddenDoc,hiddenPath,{matter:hidden}),/Project is unavailable/);
  assert.equal((await db.query('select * from matter_documents where id=$1',[hiddenDoc])).rows.length,0);
  const empty=randomUUID(); await db.query('insert into matter_documents(id,matter_id,document_type_id,title) values($1,$2,$3,$4)',[empty,project,type,'Empty']);
  assert.equal((await save(db,empty,await staged(db,empty),{create:false})).versionNumber,1);
  const legacy=randomUUID(),legacyPath=await staged(db,legacy);
  const oldApi=(await db.query('select save_ai_document($1,$2,$3,true,null,$4,$5,$6) result',[project,type,legacy,'Legacy',legacyPath,'Legacy'])).rows[0].result;
  assert.equal(oldApi.versionNumber,1);
 } finally {await db.close();}
});
test('project search finds notes, tasks and full document text, with version and access filters', async () => {
 const db=await database();
 try {
  const doc=randomUUID(),p1=await staged(db,doc),v1=await save(db,doc,p1);
  await db.query('insert into documents(matter_id,content,metadata) values($1,$2,$3)',[project,'Historical indemnity protection.',JSON.stringify({storage_path:p1})]);
  const p2=await staged(db,doc),v2=await save(db,doc,p2,{create:false,expected:v1.versionId});
  await db.query('insert into documents(matter_id,content,metadata) values($1,$2,$3)',[project,'Recitals '.repeat(2000)+'Current termination clause at the end.',JSON.stringify({storage_path:p2})]);
  await db.query('insert into matter_notes(matter_id,content) values($1,$2),($3,$4)',[project,'Check termination before execution.',hidden,'Hidden confidential termination issue']);
  await db.query('insert into matter_tasks(matter_id,title,status) values($1,$2,$3)',[project,'Review termination clause','open']);
  const hiddenSource=(await db.query('insert into documents(matter_id,content,metadata) values($1,$2,$3) returning id',[hidden,'Restricted confidential content','{}'])).rows[0].id;
  await db.exec('set role authenticated');
  const query=async(text,kind='all',allVersions=false,matter=null)=>(await db.query('select * from search_project_content($1,$2,$3,$4)',[text,matter,kind,allVersions])).rows;
  const results=await query('termination');
  assert.deepEqual(new Set(results.map(r=>r.kind)),new Set(['document','note','task']));
  assert.equal(results.find(r=>r.kind==='document').version_id,v2.versionId);
  assert.equal(results.length,3); assert.ok(results.every(r=>r.matter_id===project));
  assert.equal((await query('indemnity')).length,0);
  assert.equal((await query('indemnity','document',true))[0].version_id,v1.versionId);
  assert.equal((await query('termination','note')).length,1);
  assert.equal((await query('termination','all',false,hidden)).length,0);
  assert.equal((await query('Agreement','document'))[0].version_id,v2.versionId);
  assert.equal((await query('"termination clause"','document')).length,1);
  assert.equal((await query('!!!')).length,0);
  assert.equal((await db.query('select * from document_search_chunks where source_document_id=$1',[hiddenSource])).rows.length,0);
  await db.query("update documents set content='Replacement covenant' where metadata->>'storage_path'=$1",[p2]);
  assert.equal((await query('termination','document')).length,0);
  assert.equal((await query('covenant','document')).length,1);
  await db.query("delete from documents where metadata->>'storage_path'=$1",[p2]);
  assert.equal((await query('covenant','document')).length,0);
  await db.exec("select set_config('test.member','false',false)");
  await assert.rejects(query('termination'),/Forbidden/);
 } finally {await db.close();}
});
async function version(db) {
 const id=randomUUID();
 await db.query('insert into document_versions(id,version_number,storage_path) values($1,1,$2)',[id,`${project}/${randomUUID()}/x.docx`]);
 return id;
}
async function run(db,anchor) {
 return (await db.query('insert into ai_review_runs(document_version_id,artifact_id) values($1,$2) returning id',[anchor.versionId??null,anchor.artifactId??null])).rows[0].id;
}
async function complete(db,runId,suggestions) {
 return (await db.query('select * from complete_ai_review($1::uuid,$2::jsonb,$3::jsonb,$4::jsonb)',[runId,JSON.stringify(suggestions),'{}','{}'])).rows;
}
test('the old review payload still completes a version-anchored run', async () => {
 const db=await database();
 try {
  const versionId=await version(db),runId=await run(db,{versionId});
  await db.exec('set role authenticated');
  const rows=await complete(db,runId,[{clause_reference:'4.2',original_text:'a',suggested_text:'b',rationale:'r',review_type:'legal_clauses'}]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].document_version_id,versionId);
  assert.equal(rows[0].artifact_id,null);
  assert.equal(rows[0].status,'pending');
  assert.deepEqual(rows[0].revision_ids,[]);
  assert.equal(rows[0].placement,'placed');
  assert.equal((await db.query('select status from ai_review_runs where id=$1',[runId])).rows[0].status,'complete');
 } finally {await db.close();}
});
test('a working-document run takes ids and placement', async () => {
 const db=await database();
 try {
  const threadId=(await db.query('insert into ai_chat_threads(matter_id) values($1) returning id',[project])).rows[0].id;
  const artifactId=(await db.query("insert into ai_artifacts(thread_id,kind,title) values($1,'docx','Agreement') returning id",[threadId])).rows[0].id;
  const runId=await run(db,{artifactId});
  await db.exec('set role authenticated');
  const minted=randomUUID();
  const rows=await complete(db,runId,[
   {id:minted,thread_id:threadId,clause_reference:'4.2',original_text:'a',suggested_text:'b',rationale:'r',review_type:'legal_clauses',op:'replace',part:'word/header1.xml',paragraph_index:3,revision_ids:[9001,9002],placement:'placed'},
   {thread_id:threadId,clause_reference:'7',original_text:'c',suggested_text:'d',rationale:'r',review_type:'formatting',placement:'unplaced',placement_reason:'ambiguous',revision_ids:[]},
  ]);
  assert.equal(rows.length,2);
  // A row that brought its id keeps it; one without gets one.
  assert.equal(rows[0].id,minted);
  assert.ok(rows[1].id&&rows[1].id!==minted);
  assert.ok(rows.every(r=>r.artifact_id===artifactId&&r.document_version_id===null&&r.thread_id===threadId));
  assert.deepEqual(rows[0].revision_ids,[9001,9002]);
  assert.equal(rows[0].part,'word/header1.xml');
  assert.equal(rows[0].paragraph_index,3);
  assert.equal(rows[0].placement,'placed');
  assert.deepEqual(rows[1].revision_ids,[]);
  assert.equal(rows[1].part,'word/document.xml');
  assert.equal(rows[1].placement,'unplaced');
  assert.equal(rows[1].placement_reason,'ambiguous');
  await assert.rejects(run(db,{}),/ai_review_runs_anchor_check/);
 } finally {await db.close();}
});
test('decisions are stamped and cleared', async () => {
 const db=await database();
 try {
  const versionId=await version(db);
  await db.exec('set role authenticated');
  const id=(await db.query('insert into redline_suggestions(document_version_id) values($1) returning id',[versionId])).rows[0].id;
  const row=async()=>(await db.query('select status,decided_at,decided_by from redline_suggestions where id=$1',[id])).rows[0];
  await db.query("update redline_suggestions set status='accepted' where id=$1",[id]);
  let r=await row();
  assert.ok(r.decided_at instanceof Date);
  assert.equal(r.decided_by,user);
  await db.query("update redline_suggestions set status='pending' where id=$1",[id]);
  r=await row();
  assert.equal(r.decided_at,null);
  assert.equal(r.decided_by,null);
  const decided=(await db.query("insert into redline_suggestions(document_version_id,status) values($1,'accepted') returning decided_at",[versionId])).rows[0];
  assert.ok(decided.decided_at instanceof Date);
  await db.query("update redline_suggestions set status='accepted' where id=$1",[id]);
  await assert.rejects(db.query('update redline_suggestions set decided_at=null where id=$1',[id]),/redline_suggestions_decision_check/);
 } finally {await db.close();}
});

// ---------------------------------------------------------------- quick wins
// The live policies as they stood before 20261016090000_quick_wins.sql, on
// stub tables, with auth.uid() and roles switchable per statement.
const admin='00000000-0000-0000-0000-0000000000a1';
const author='00000000-0000-0000-0000-0000000000a2';
const colleague='00000000-0000-0000-0000-0000000000a3';
const quickWins=()=>readFileSync('supabase/migrations/20261016090000_quick_wins.sql','utf8');
async function quickWinsDatabase(seed=async()=>{}) {
 const db=await database();
 await db.exec(`
 create or replace function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('test.uid',true),''),'${user}')::uuid $$;
 create type public.app_role as enum ('admin','partner','associate','paralegal','senior_counsel','founder');
 create table public.user_roles(user_id uuid,role public.app_role);
 insert into public.user_roles values('${admin}','admin');
 create function public.has_role(_user_id uuid,_role public.app_role) returns boolean language sql stable security definer as $$ select exists(select 1 from public.user_roles where user_id=_user_id and (role=_role or (_role='admin' and role='founder'))) $$;
 create function public.is_supervisor(_user_id uuid) returns boolean language sql stable as $$ select public.has_role(_user_id,'admin') or public.has_role(_user_id,'partner') or public.has_role(_user_id,'senior_counsel') $$;
 create table public.ai_skills(id uuid primary key default gen_random_uuid(),name text,created_by uuid);
 create table public.matter_timeslips(id uuid primary key default gen_random_uuid(),matter_id uuid,author_id uuid,hours numeric(5,2));
 alter table matter_documents enable row level security;
 alter table document_versions enable row level security;
 alter table document_type_templates enable row level security;
 alter table ai_skills enable row level security;
 alter table matter_timeslips enable row level security;
 alter table storage.objects enable row level security;
 create policy "Firm members can view matter documents" on matter_documents for select using (is_firm_member(auth.uid()));
 create policy "Firm members can manage matter documents" on matter_documents for all using (is_firm_member(auth.uid())) with check (is_firm_member(auth.uid()));
 create policy "Firm members can view document versions" on document_versions for select using (is_firm_member(auth.uid()));
 create policy "Firm members can create document versions" on document_versions for insert with check (is_firm_member(auth.uid()));
 create policy "Firm members can update document versions" on document_versions for update using (is_firm_member(auth.uid())) with check (is_firm_member(auth.uid()));
 create policy "Firm members can delete document versions" on document_versions for delete using (is_firm_member(auth.uid()));
 create policy "Firm members can view document type templates" on document_type_templates for select using (is_firm_member(auth.uid()));
 create policy "Firm members can manage document type templates" on document_type_templates for all using (is_firm_member(auth.uid())) with check (is_firm_member(auth.uid()));
 create policy "Firm members can view skills" on ai_skills for select using (is_firm_member(auth.uid()));
 create policy "Firm members can delete skills" on ai_skills for delete using (is_firm_member(auth.uid()));
 create policy "Firm members can view all timeslips" on matter_timeslips for select using (is_firm_member(auth.uid()));
 create policy "Authors and partners can update timeslips" on matter_timeslips for update using ((author_id = auth.uid()) or has_role(auth.uid(),'admin') or has_role(auth.uid(),'partner')) with check ((author_id = auth.uid()) or has_role(auth.uid(),'admin') or has_role(auth.uid(),'partner'));
 create policy "Authors and partners can delete timeslips" on matter_timeslips for delete using ((author_id = auth.uid()) or has_role(auth.uid(),'admin') or has_role(auth.uid(),'partner'));
 create policy "Firm members can read precedent library bucket" on storage.objects for select using (bucket_id='precedent-library' and is_firm_member(auth.uid()));
 create policy "Firm members can write precedent library bucket" on storage.objects for insert with check (bucket_id='precedent-library' and is_firm_member(auth.uid()));
 create policy "Firm members can delete precedent library bucket" on storage.objects for delete using (bucket_id='precedent-library' and is_firm_member(auth.uid()));
 `);
 await seed(db);
 await db.exec(quickWins());
 await db.exec(quickWins()); // a second run changes nothing
 await db.exec('grant select,insert,update,delete on all tables in schema public,storage to authenticated; set role authenticated;');
 return db;
}
const as=(db,uid)=>db.query("select set_config('test.uid',$1,false)",[uid]);
const deleted=async(db,sql,params)=>(await db.query(sql+' returning id',params)).rows.length;

test('quick wins (a): old unknown/pending versions become indexed where passages exist, else failed', async () => {
 const ids={};
 const db=await quickWinsDatabase(async(db)=>{
  const doc=(await db.query("insert into matter_documents(matter_id,title) values($1,'Lease') returning id",[project])).rows[0].id;
  const add=async(name,status,age,chunks)=>{
   const path=`${project}/${doc}/${name}.pdf`;
   ids[name]=(await db.query(`insert into document_versions(matter_document_id,version_number,storage_path,indexing_status,created_at) values($1,$2,$3,$4,now()-$5::interval) returning id`,[doc,Object.keys(ids).length+1,path,status,age])).rows[0].id;
   if(chunks) await db.query('insert into documents(matter_id,content,metadata) values($1,$2,$3)',[project,'text',JSON.stringify({storage_path:path})]);
  };
  await add('oldRead','unknown','3 days',true);
  await add('oldUnread','unknown','3 days',false);
  await add('stuckPending','pending','2 hours',true);
  await add('justUploaded','unknown','5 minutes',false);
  await add('alreadyFailed','failed','3 days',true);
 });
 try {
  const status=async(name)=>(await db.query('select indexing_status from document_versions where id=$1',[ids[name]])).rows[0].indexing_status;
  assert.equal(await status('oldRead'),'indexed');
  assert.equal(await status('oldUnread'),'failed');
  assert.equal(await status('stuckPending'),'indexed');
  assert.equal(await status('justUploaded'),'unknown');
  assert.equal(await status('alreadyFailed'),'failed');
 } finally {await db.close();}
});

test('quick wins (b): only an administrator can set or remove a standard, everyone can read it', async () => {
 const db=await quickWinsDatabase(async(db)=>{
  await db.query("insert into document_type_templates(document_type_id,storage_path,filename,content_html) values($1,'standards/x/1-a.docx','a.docx','text')",[type]);
 });
 try {
  await as(db,colleague);
  assert.equal((await db.query('select * from document_type_templates')).rows.length,1);
  assert.equal((await db.query("update document_type_templates set filename='b.docx' returning 1")).rows.length,0);
  await assert.rejects(db.query("insert into document_type_templates(document_type_id,content_html) values($1,'x') on conflict (document_type_id) do update set content_html='x'",[type]),/row-level security/);
  assert.equal((await db.query('delete from document_type_templates where document_type_id=$1 returning 1',[type])).rows.length,0);
  await assert.rejects(db.query("insert into storage.objects values('precedent-library','standards/x/2-b.docx')"),/row-level security/);
  await db.query("insert into storage.objects values('precedent-library','precedent/x/2-b.docx')");
  await as(db,admin);
  await db.query("insert into storage.objects values('precedent-library','standards/x/3-c.docx')");
  await db.query("update document_type_templates set filename='c.docx',storage_path='standards/x/3-c.docx'");
  assert.equal((await db.query('select filename from document_type_templates')).rows[0].filename,'c.docx');
 } finally {await db.close();}
});

test('quick wins (c): a firm skill can be deleted only by an administrator or its creator', async () => {
 const db=await quickWinsDatabase(async(db)=>{
  await db.query("insert into ai_skills(name,created_by) values('mine',$1),('other',$1),('third',$1)",[author]);
 });
 try {
  const del=(name)=>deleted(db,'delete from ai_skills where name=$1',[name]);
  await as(db,colleague);
  assert.equal(await del('mine'),0);
  await as(db,author);
  assert.equal(await del('mine'),1);
  await as(db,admin);
  assert.equal(await del('other'),1);
  await db.exec("select set_config('test.member','false',false)");
  await as(db,author);
  assert.equal(await del('third'),0,'an author who is no longer approved cannot delete');
 } finally {await db.close();}
});

test('quick wins (d): a project document can be deleted only by an administrator or its creator; anyone can still edit', async () => {
 const docs={};
 const db=await quickWinsDatabase(async(db)=>{
  for(const [name,creator] of [['byAuthor',author],['byAuthor2',author],['legacy',null]]) {
   docs[name]=(await db.query('insert into matter_documents(matter_id,title,created_by) values($1,$2,$3) returning id',[project,name,creator])).rows[0].id;
   await db.query("insert into document_versions(matter_document_id,version_number,storage_path,uploaded_by) values($1,1,$2,$3),($1,2,$4,$5)",[docs[name],`${project}/${docs[name]}/v1.docx`,creator??colleague,`${project}/${docs[name]}/v2.docx`,admin]);
  }
 });
 try {
  const delDoc=(name)=>deleted(db,'delete from matter_documents where id=$1',[docs[name]]);
  const delVersion=(name,n)=>deleted(db,'delete from document_versions where matter_document_id=$1 and version_number=$2',[docs[name],n]);
  await as(db,colleague);
  assert.equal(await delDoc('byAuthor'),0);
  assert.equal(await delVersion('byAuthor',1),0);
  await db.query("update matter_documents set title='Renamed by a colleague' where id=$1",[docs.byAuthor]);
  assert.equal((await db.query('select title from matter_documents where id=$1',[docs.byAuthor])).rows[0].title,'Renamed by a colleague');
  await db.query("insert into matter_documents(matter_id,title,created_by) values($1,'New',$2)",[project,colleague]);
  // No creator recorded: whoever uploaded the first version counts as the creator.
  assert.equal(await delDoc('legacy'),1);
  await as(db,author);
  assert.equal(await delVersion('byAuthor',2),1,"the document's creator can remove a version someone else uploaded");
  assert.equal(await delDoc('byAuthor'),1);
  assert.equal((await db.query('select * from document_versions where matter_document_id=$1',[docs.byAuthor])).rows.length,0,'versions go with the document');
  await as(db,admin);
  assert.equal(await delDoc('byAuthor2'),1);
 } finally {await db.close();}
});

test('quick wins (e): timeslip billable columns exist and the author policies are not duplicated', async () => {
 const db=await quickWinsDatabase();
 try {
  const cols=(await db.query("select column_name from information_schema.columns where table_name='matter_timeslips' and column_name like '%billable_hours' order by 1")).rows.map(r=>r.column_name);
  assert.deepEqual(cols,['ak_billable_hours','billable_hours']);
  const policies=(await db.query("select policyname from pg_policies where tablename='matter_timeslips' order by 1")).rows.map(r=>r.policyname);
  assert.deepEqual(policies,['Authors and partners can delete timeslips','Authors and partners can update timeslips','Firm members can view all timeslips']);
 } finally {await db.close();}
});

test('quick wins (e): on a database without author timeslip policies, authors get them', async () => {
 const db=await quickWinsDatabase(async(db)=>{
  await db.exec('drop policy "Authors and partners can update timeslips" on matter_timeslips; drop policy "Authors and partners can delete timeslips" on matter_timeslips;');
  await db.query('insert into matter_timeslips(matter_id,author_id,hours) values($1,$2,1),($1,$2,2)',[project,author]);
 });
 try {
  await as(db,colleague);
  assert.equal((await db.query('update matter_timeslips set hours=3 returning id')).rows.length,0);
  await as(db,author);
  assert.equal((await db.query('update matter_timeslips set hours=3 where hours=1 returning id')).rows.length,1);
  assert.equal(await deleted(db,'delete from matter_timeslips where hours=2',[]),1);
 } finally {await db.close();}
});
