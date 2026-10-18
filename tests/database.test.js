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

// ---------------------------------------------------------- indexing pipeline
// 20261017090000_indexing_pipeline.sql on the stub schema. PGlite is a single
// connection, so FOR UPDATE SKIP LOCKED cannot be raced here; the claim tests
// cover what a second worker sees: a held lock (running, locked_until in the
// future) is skipped, an expired one is taken over.
const indexingSql=()=>readFileSync('supabase/migrations/20261017090000_indexing_pipeline.sql','utf8');
async function indexingDatabase(seed=async()=>{}) {
 const db=await database();
 await db.exec(`
 do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if; end $$;
 create or replace function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('test.uid',true),''),'${user}')::uuid $$;
 alter table documents add column if not exists is_precedent boolean not null default false, add column if not exists is_statute boolean not null default false;
 `);
 await seed(db);
 await db.exec(indexingSql());
 await db.exec(indexingSql()); // a second run changes nothing
 return db;
}
const jobOf=async(db,versionId)=>(await db.query('select * from document_index_jobs where document_version_id=$1',[versionId])).rows[0];
const versionRow=async(db,id)=>(await db.query('select indexing_status,indexing_error,indexing_attempts,page_count,card,indexing_started_at,indexing_finished_at from document_versions where id=$1',[id])).rows[0];
const claimJob=async(db,worker='w1')=>(await db.query('select * from claim_index_job($1)',[worker])).rows[0]??null;
async function addPassages(db,{versionId=null,runId=null,path,count=2,matter=project}) {
 for(let i=0;i<count;i++) await db.query('insert into documents(matter_id,content,metadata,document_version_id,ingest_run_id) values($1,$2,$3,$4,$5)',[matter,`passage ${i} of ${runId??'legacy'}`,JSON.stringify({storage_path:path}),versionId,runId]);
}

test('indexing: saving a readable file queues one job; other files and direct writes do not', async () => {
 const db=await indexingDatabase();
 try {
  await db.exec('set role authenticated');
  const doc=randomUUID();
  const v1=await save(db,doc,await staged(db,doc));
  const job=await jobOf(db,v1.versionId);
  assert.equal(job.state,'queued');
  assert.equal(job.kind,'project');
  assert.equal(job.bucket,'matter-documents');
  assert.equal(job.attempts,0);
  // A picture is saved but never queued.
  const pic=randomUUID();
  const vPic=await save(db,pic,await staged(db,pic,randomUUID()+'.jpg'));
  assert.equal(await jobOf(db,vPic.versionId),undefined);
  // Members can see the queue but not write to it.
  assert.equal((await db.query('select * from document_index_jobs')).rows.length,1);
  await assert.rejects(db.query("insert into document_index_jobs(bucket,storage_path) values('matter-documents','x.pdf')"),/permission denied/);
  await assert.rejects(db.query("update document_index_jobs set state='done'"),/permission denied/);
  await assert.rejects(db.query("select * from claim_index_job('sneaky')"),/permission denied/);
 } finally {await db.close();}
});

test('indexing: existing project passages are linked to their version by storage path', async () => {
 let v, path;
 const db=await indexingDatabase(async(db)=>{
  const doc=randomUUID(); path=await staged(db,doc); v=await save(db,doc,path);
  for(let i=0;i<3;i++) await db.query('insert into documents(matter_id,content,metadata) values($1,$2,$3)',[project,`passage ${i}`,JSON.stringify({storage_path:path})]);
  await db.query('insert into documents(matter_id,content,metadata) values(null,$1,$2)',['a precedent',JSON.stringify({storage_path:path})]);
 });
 try {
  const rows=(await db.query("select document_version_id,version_number from documents where metadata->>'storage_path'=$1 and matter_id is not null",[path])).rows;
  assert.equal(rows.length,3);
  assert.ok(rows.every(r=>r.document_version_id===v.versionId&&r.version_number===1));
  assert.equal((await db.query("select document_version_id from documents where matter_id is null")).rows[0].document_version_id,null,'library rows are left alone');
  const tsv=(await db.query("select tsv::text from documents where matter_id is not null limit 1")).rows[0].tsv;
  assert.match(tsv,/'passag'/);
 } finally {await db.close();}
});

test('indexing: claim takes the oldest due job, skips held locks and backoff, takes over an expired lock', async () => {
 const db=await indexingDatabase();
 try {
  await db.exec('set role authenticated');
  const ids=[];
  for(let i=0;i<3;i++){ const doc=randomUUID(); ids.push((await save(db,doc,await staged(db,doc))).versionId); }
  await db.exec('reset role');
  await db.query("update document_index_jobs set created_at=now()-($2||' minutes')::interval where document_version_id=$1",[ids[0],'30']);
  await db.query("update document_index_jobs set created_at=now()-($2||' minutes')::interval where document_version_id=$1",[ids[1],'20']);
  await db.query("update document_index_jobs set created_at=now()-($2||' minutes')::interval, locked_until=now()+interval '5 minutes' where document_version_id=$1",[ids[2],'40']);
  const a=await claimJob(db,'w1');
  assert.equal(a.document_version_id,ids[0],'oldest due job first; the backed-off one waits');
  assert.equal(a.state,'running'); assert.equal(a.attempts,1); assert.ok(a.run_id); assert.equal(a.worker,'w1');
  assert.ok(new Date(a.locked_until)>new Date(Date.now()+19*60_000));
  const va=await versionRow(db,ids[0]);
  assert.equal(va.indexing_status,'pending'); assert.equal(va.indexing_attempts,1); assert.ok(va.indexing_started_at);
  const b=await claimJob(db,'w2');
  assert.equal(b.document_version_id,ids[1],'a job another worker holds is skipped');
  assert.equal(await claimJob(db,'w3'),null,'nothing else is due');
  // A bulk re-read (priority -1) waits behind a file someone has just added, however old it is.
  await db.exec('set role authenticated');
  const fresh=randomUUID(),freshV=(await save(db,fresh,await staged(db,fresh))).versionId;
  const bulk=randomUUID(),bulkV=(await save(db,bulk,await staged(db,bulk))).versionId;
  await db.exec('reset role');
  await db.query("update document_index_jobs set priority=-1, created_at=now()-interval '1 day' where document_version_id=$1",[bulkV]);
  assert.equal((await claimJob(db,'w5')).document_version_id,freshV);
  assert.equal((await claimJob(db,'w6')).document_version_id,bulkV);
  // w1 dies mid-run: its lock lapses, its half-written passages go, w3 takes over with a new run.
  await addPassages(db,{versionId:ids[0],runId:a.run_id,path:a.storage_path});
  await db.query("update document_index_jobs set locked_until=now()-interval '1 second' where id=$1",[a.id]);
  const again=await claimJob(db,'w3');
  assert.equal(again.id,a.id); assert.equal(again.attempts,2); assert.notEqual(again.run_id,a.run_id);
  assert.equal((await db.query('select * from documents where ingest_run_id=$1',[a.run_id])).rows.length,0);
  // A worker that died on the last allowed attempt: the job fails instead of looping.
  await db.query("update document_index_jobs set attempts=3, locked_until=now()-interval '1 second' where id=$1",[b.id]);
  assert.equal(await claimJob(db,'w4'),null);
  assert.equal((await db.query('select state from document_index_jobs where id=$1',[b.id])).rows[0].state,'failed');
  const vb=await versionRow(db,ids[1]);
  assert.equal(vb.indexing_status,'failed'); assert.match(vb.indexing_error,/kept stopping/);
 } finally {await db.close();}
});

test('indexing: publish swaps old passages for the new run in one step; a stale run changes nothing', async () => {
 const db=await indexingDatabase();
 try {
  await db.exec('set role authenticated');
  const doc=randomUUID(),path=await staged(db,doc),v=await save(db,doc,path);
  const otherDoc=randomUUID(),otherPath=await staged(db,otherDoc),other=await save(db,otherDoc,otherPath);
  await db.exec('reset role');
  await addPassages(db,{path,count:2});                                   // the old edge-function rows
  await addPassages(db,{versionId:v.versionId,runId:randomUUID(),path});  // an earlier worker run
  await addPassages(db,{versionId:other.versionId,runId:randomUUID(),path:otherPath}); // another file
  const job=await claimJob(db);
  assert.equal(job.document_version_id,v.versionId);
  await assert.rejects(db.query('select publish_index_run($1,$2)',[job.id,job.run_id]),/No passages were written/);
  await addPassages(db,{versionId:v.versionId,runId:job.run_id,path,count:3});
  // Not this run: refused, and nothing is deleted.
  await assert.rejects(db.query('select publish_index_run($1,$2)',[job.id,randomUUID()]),/no longer current/);
  assert.equal((await db.query("select count(*)::int n from documents where metadata->>'storage_path'=$1",[path])).rows[0].n,7);
  const result=(await db.query('select publish_index_run($1,$2,$3,$4) r',[job.id,job.run_id,12,JSON.stringify({summary:'A lease.',has_tracked_changes:true})])).rows[0].r;
  assert.deepEqual(result,{passages:3,removed:4});
  const left=(await db.query("select ingest_run_id from documents where metadata->>'storage_path'=$1",[path])).rows;
  assert.equal(left.length,3); assert.ok(left.every(r=>r.ingest_run_id===job.run_id));
  assert.equal((await db.query("select count(*)::int n from documents where metadata->>'storage_path'=$1",[otherPath])).rows[0].n,2,'other files untouched');
  const row=await versionRow(db,v.versionId);
  assert.equal(row.indexing_status,'indexed'); assert.equal(row.page_count,12); assert.equal(row.card.summary,'A lease.');
  assert.equal(row.indexing_error,null); assert.ok(row.indexing_finished_at);
  const done=await jobOf(db,v.versionId);
  assert.equal(done.state,'done'); assert.equal(done.locked_until,null);
  await assert.rejects(db.query('select publish_index_run($1,$2)',[job.id,job.run_id]),/no longer current/,'a run publishes once');
 } finally {await db.close();}
});

test('indexing: a failure backs off 2 then 4 minutes, then gives up with the reason; a permanent one gives up at once', async () => {
 const db=await indexingDatabase();
 try {
  await db.exec('set role authenticated');
  const doc=randomUUID(),path=await staged(db,doc),v=await save(db,doc,path);
  const doc2=randomUUID(),v2=await save(db,doc2,await staged(db,doc2));
  await db.exec('reset role');
  await db.query("update document_index_jobs set created_at=now()-interval '1 hour' where document_version_id=$1",[v.versionId]);
  const lockMinutes=async(id)=>(await db.query("select extract(epoch from (locked_until-now()))/60 m,state,last_error from document_index_jobs where id=$1",[id])).rows[0];
  let job=await claimJob(db);
  await addPassages(db,{versionId:v.versionId,runId:job.run_id,path});
  assert.equal((await db.query('select fail_index_job($1,$2,true,$3) r',[job.id,'The search service did not respond.',job.run_id])).rows[0].r,'queued');
  let j=await lockMinutes(job.id);
  assert.equal(j.state,'queued'); assert.ok(j.m>1.9&&j.m<=2.01,`backoff ${j.m}`);
  assert.equal((await db.query('select * from documents where ingest_run_id=$1',[job.run_id])).rows.length,0,'half-written passages removed');
  let row=await versionRow(db,v.versionId);
  assert.equal(row.indexing_status,'pending'); assert.equal(row.indexing_error,null,'no reason shown while it will be retried');
  // Not due yet: the other file is claimed instead.
  const otherJob=await claimJob(db);
  assert.equal(otherJob.document_version_id,v2.versionId);
  await db.query("update document_index_jobs set locked_until=now()-interval '1 second' where id=$1",[job.id]);
  job=await claimJob(db); assert.equal(job.attempts,2);
  await db.query('select fail_index_job($1,$2,true,$3)',[job.id,'Timed out.',job.run_id]);
  j=await lockMinutes(job.id); assert.ok(j.m>3.9&&j.m<=4.01,`backoff ${j.m}`);
  // A stale worker's report for an old run is ignored.
  assert.equal((await db.query('select fail_index_job($1,$2,false,$3) r',[job.id,'late',randomUUID()])).rows[0].r,'stale');
  await db.query("update document_index_jobs set locked_until=now()-interval '1 second' where id=$1",[job.id]);
  job=await claimJob(db); assert.equal(job.attempts,3);
  assert.equal((await db.query('select fail_index_job($1,$2,true,$3) r',[job.id,'No readable text, even after OCR.',job.run_id])).rows[0].r,'failed');
  row=await versionRow(db,v.versionId);
  assert.equal(row.indexing_status,'failed'); assert.equal(row.indexing_error,'No readable text, even after OCR.'); assert.equal(row.indexing_attempts,3);
  assert.equal((await jobOf(db,v.versionId)).state,'failed');
  assert.equal(await claimJob(db),null,'a failed job is not picked up again');
  // Permanent on the first attempt.
  assert.equal((await db.query('select fail_index_job($1,$2,false,$3) r',[otherJob.id,'The PDF is password-protected.',otherJob.run_id])).rows[0].r,'failed');
  assert.equal((await versionRow(db,v2.versionId)).indexing_error,'The PDF is password-protected.');
 } finally {await db.close();}
});

test('indexing: Try again re-queues a failed version for members only; a stopping worker hands its job back', async () => {
 const db=await indexingDatabase();
 try {
  await db.exec('set role authenticated');
  const doc=randomUUID(),path=await staged(db,doc),v=await save(db,doc,path);
  await db.exec('reset role');
  let job=await claimJob(db);
  await db.query('select fail_index_job($1,$2,false,$3)',[job.id,'The PDF is password-protected.',job.run_id]);
  await db.exec('set role authenticated');
  const queued=(await db.query('select enqueue_index_job($1) r',[v.versionId])).rows[0].r;
  assert.equal(queued.state,'queued');
  const row=await versionRow(db,v.versionId);
  assert.equal(row.indexing_status,'pending'); assert.equal(row.indexing_error,null); assert.equal(row.indexing_attempts,0);
  const reset=await jobOf(db,v.versionId);
  assert.equal(reset.attempts,0); assert.equal(reset.last_error,null); assert.equal(reset.locked_until,null);
  // Pressing it again while queued changes nothing.
  assert.equal((await db.query('select enqueue_index_job($1) r',[v.versionId])).rows[0].r.state,'queued');
  // A file saved before the queue existed gets a job on request.
  await db.exec('reset role');
  const legacyDoc=randomUUID(); await db.query("insert into matter_documents(id,matter_id,title) values($1,$2,'Old')",[legacyDoc,project]);
  await db.exec('alter table document_versions disable trigger document_versions_enqueue_index');
  const legacy=(await db.query("insert into document_versions(matter_document_id,version_number,storage_path,indexing_status) values($1,1,$2,'unknown') returning id",[legacyDoc,`${project}/${legacyDoc}/old.pdf`])).rows[0].id;
  await db.exec('alter table document_versions enable trigger document_versions_enqueue_index');
  await db.exec('set role authenticated');
  assert.equal((await db.query('select enqueue_index_job($1) r',[legacy])).rows[0].r.state,'queued');
  assert.equal((await versionRow(db,legacy)).indexing_status,'pending');
  await db.exec("select set_config('test.member','false',false)");
  await assert.rejects(db.query('select enqueue_index_job($1)',[v.versionId]),/Forbidden/);
  await db.exec("select set_config('test.member','true',false)");
  // A deploy stops the worker mid-job: queued again, attempt not counted, partial rows gone.
  await db.exec('reset role');
  await db.query("update document_index_jobs set created_at=now()-interval '1 day' where document_version_id=$1",[v.versionId]);
  job=await claimJob(db);
  assert.equal(job.document_version_id,v.versionId); assert.equal(job.attempts,1);
  await addPassages(db,{versionId:v.versionId,runId:job.run_id,path});
  assert.equal((await db.query('select release_index_job($1,$2) r',[job.id,job.run_id])).rows[0].r,true);
  const back=await jobOf(db,v.versionId);
  assert.equal(back.state,'queued'); assert.equal(back.attempts,0); assert.equal(back.run_id,null);
  assert.equal((await db.query('select * from documents where ingest_run_id=$1',[job.run_id])).rows.length,0);
  assert.equal((await db.query('select touch_index_job($1,$2) r',[job.id,job.run_id])).rows[0].r,null,'a released run cannot renew its lock');
 } finally {await db.close();}
});

// ------------------------------------------------- hybrid search (C2)
// PGlite has no pgvector, so `vector` is stubbed as a float8[] domain with a
// SQL cosine distance behind `<=>`: the vector leg runs for real on tiny
// three-number embeddings. The HNSW index and its settings are not
// exercised here (set_config on hnsw.* is a harmless placeholder in PGlite).
const hybridSql=()=>readFileSync('supabase/migrations/20261017120000_hybrid_search.sql','utf8');
// The same search, faster (18 Oct): replaces the function; the tests below run on it.
const hybridSpeedSql=()=>readFileSync('supabase/migrations/20261018120000_hybrid_search_speed.sql','utf8');
const vec=(a)=>(a?`{${a.join(',')}}`:null);
async function hybridDatabase() {
 const db=await indexingDatabase(async(db)=>{
  await db.exec(`
  create domain public.vector as float8[];
  create function public.vector_cosine_stub(a float8[], b float8[]) returns float8 language sql immutable as $$
   select 1 - (select sum(x*y) from unnest(a,b) u(x,y)) / nullif(sqrt((select sum(x*x) from unnest(a) x)) * sqrt((select sum(y*y) from unnest(b) y)),0) $$;
  create operator public.<=> (leftarg=float8[], rightarg=float8[], function=public.vector_cosine_stub);
  alter table documents add column if not exists document_type_id uuid, add column if not exists embedding vector;
  `);
 });
 await db.exec(readFileSync('supabase/migrations/20260921090000_precedent_passages.sql','utf8'));
 await db.exec(hybridSql());
 await db.exec(hybridSql()); // a second run changes nothing
 await db.exec(hybridSpeedSql());
 await db.exec(hybridSpeedSql());
 return db;
}
// A project document with versions; returns { docId, versions: [{ id, path }] }.
async function projectDoc(db,title,versions) {
 const docId=randomUUID();
 await db.query('insert into matter_documents(id,matter_id,title) values($1,$2,$3)',[docId,project,title]);
 await db.exec('alter table document_versions disable trigger document_versions_enqueue_index');
 const out=[];
 for(const [i,v] of versions.entries()) {
  const path=`${project}/${docId}/${v.file??`v${i+1}.docx`}`;
  const id=(await db.query('insert into document_versions(matter_document_id,version_number,storage_path,file_name,is_ai_generated) values($1,$2,$3,$4,$5) returning id',[docId,i+1,path,v.file??`v${i+1}.docx`,!!v.ai])).rows[0].id;
  out.push({id,path});
 }
 await db.exec('alter table document_versions enable trigger document_versions_enqueue_index');
 return {docId,versions:out};
}
// A project passage: linked to its version, or (legacy) only by storage path.
async function passage(db,{version=null,docId=null,path,content,embedding=[1,0,0],legacy=false,filename=null}) {
 return (await db.query(`insert into documents(matter_id,content,metadata,embedding,document_version_id,matter_document_id,heading_path)
  values($1,$2,$3,$4,$5,$6,$7) returning id`,[project,content,JSON.stringify({storage_path:path,filename:filename??path.split('/').pop()}),vec(embedding),legacy?null:version,legacy?null:docId,null])).rows[0].id;
}
const search=async(db,args)=>(await db.query(`select * from search_passages(query_text=>$1,query_embedding=>$2,scope=>$3,matter_id=>$4,act_names=>$5,document_type_id=>$6,all_versions=>$7,exclude_document_id=>$8,k=>$9)`,
 [args.q,vec(args.emb),args.scope??'project','matter' in args?args.matter:project,args.acts??null,args.type??null,args.all??false,args.exclude??null,args.k??40])).rows;

test('hybrid search: only the current, human-written version of a project document is searched unless all versions are asked for', async () => {
 const db=await hybridDatabase();
 try {
  const term=await projectDoc(db,'Term Sheet',[{},{},{ai:true}]);
  const [v1,v2,v3]=term.versions;
  await passage(db,{version:v1.id,docId:term.docId,path:v1.path,content:'The concession period is twenty (20) years.'});
  const legacyV2=await passage(db,{path:v2.path,content:'The concession period is twenty-five (25) years.',legacy:true});
  const linkedV2=await passage(db,{version:v2.id,docId:term.docId,path:v2.path,content:'Termination: the concession period ends early on default.'});
  await passage(db,{version:v3.id,docId:term.docId,path:v3.path,content:'AI draft: the concession period is thirty (30) years.'});
  const other=await projectDoc(db,'Opinion',[{}]);
  await passage(db,{version:other.versions[0].id,docId:other.docId,path:other.versions[0].path,content:'Our opinion on the concession period.'});

  const rows=await search(db,{q:'concession period'});
  const ids=rows.map(r=>r.id);
  assert.ok(ids.includes(legacyV2),'a legacy passage of the current version is found by its storage path');
  assert.ok(ids.includes(linkedV2));
  assert.ok(!rows.some(r=>/twenty \(20\)|thirty/.test(r.content)),'neither the superseded v1 nor the AI-generated v3 is searched');
  const legacyRow=rows.find(r=>r.id===legacyV2);
  assert.equal(legacyRow.version_number,2,'the version is found for a legacy passage too');
  assert.equal(legacyRow.document_version_id,v2.id);
  assert.equal(legacyRow.metadata.document_title,'Term Sheet');

  const every=await search(db,{q:'concession period',all:true});
  assert.equal(every.filter(r=>r.matter_document_id===term.docId).length,4,'all versions: v1, both v2 passages and the AI v3 (a file is a version)');
  assert.ok(every.some(r=>/twenty \(20\)/.test(r.content))&&every.some(r=>/thirty/.test(r.content)));

  const excluded=await search(db,{q:'concession period',exclude:term.docId});
  assert.deepEqual(excluded.map(r=>r.content),['Our opinion on the concession period.'],'exclude_document_id drops every version of that document, legacy passages included');
  assert.deepEqual(await search(db,{q:'concession period',matter:null}),[],'a project search needs a project');
  await db.exec('set role authenticated');
  assert.deepEqual((await search(db,{q:'concession period'})).map(r=>r.id).sort(),ids.slice().sort(),'a signed-in member runs it (security invoker, granted to authenticated)');
  await db.exec('reset role');
  await assert.rejects(search(db,{q:'x',scope:'everything'}),/scope must be/);
 } finally {await db.close();}
});

test('hybrid search: at most three passages come from one file, and the fused ranks are reported', async () => {
 const db=await hybridDatabase();
 try {
  const big=await projectDoc(db,'Agreement',[{}]);
  for(let i=0;i<6;i++) await passage(db,{version:big.versions[0].id,docId:big.docId,path:big.versions[0].path,content:i===0?'Clause 0: liquidated damages for delay; liquidated damages for delay are capped.':`Clause ${i}: liquidated damages for delay are capped.`,embedding:[1,i/10,0]});
  const small=await projectDoc(db,'Side Letter',[{}]);
  await passage(db,{version:small.versions[0].id,docId:small.docId,path:small.versions[0].path,content:'Liquidated damages for delay in the side letter.',embedding:[0,1,0]});
  const rows=await search(db,{q:'liquidated damages delay',emb:[1,0,0]});
  assert.equal(rows.filter(r=>r.matter_document_id===big.docId).length,3);
  assert.equal(rows.filter(r=>r.matter_document_id===small.docId).length,1);
  const top=rows[0];
  assert.match(top.content,/Clause 0/,'nearest in meaning and a keyword hit: first');
  assert.equal(top.vector_rank,1);
  assert.ok(top.keyword_rank>=1);
  assert.ok(Math.abs(top.rrf_score-(1/61+1/(60+top.keyword_rank)))<1e-9,'rrf is 1/(60+rank) summed over the legs');
  for(let i=1;i<rows.length;i++) assert.ok(rows[i-1].rrf_score>=rows[i].rrf_score,'ordered by fused score');
  // No embedding (the embedding service is down): the keyword leg still answers.
  const words=await search(db,{q:'liquidated damages delay'});
  assert.ok(words.length>=2&&words.every(r=>r.vector_rank===null&&r.keyword_rank!==null));
 } finally {await db.close();}
});

test('hybrid search: when fewer than five passages hold every word, any of the words will do, most words first', async () => {
 const db=await hybridDatabase();
 try {
  // Each passage in its own file, so the per-file cap does not interfere.
  const add=async(content)=>{const d=await projectDoc(db,'Report',[{}]);return passage(db,{version:d.versions[0].id,docId:d.docId,path:d.versions[0].path,content});};
  const both=await add('The indicative project cost is PKR 190 billion including IDC.');
  const one=await add('IDC is interest during construction.');
  const none=await add('The weather in Karachi.');
  // "motorway" is in no passage, so the every-word query finds nothing.
  const rows=await search(db,{q:'indicative project cost of the motorway including IDC'});
  const ids=rows.map(r=>r.id);
  assert.ok(ids.includes(both)&&ids.includes(one));
  assert.ok(!ids.includes(none));
  assert.ok(ids.indexOf(both)<ids.indexOf(one),'the passage holding more of the words ranks first');
  // Five or more passages with every word: only those are keyword hits.
  for(let i=0;i<5;i++) await add(`Clause ${i}: the motorway cost includes IDC.${' '.repeat(i)}`);
  const strict=await search(db,{q:'motorway cost IDC'});
  assert.ok(strict.length>=5);
  assert.ok(strict.every(r=>/motorway/i.test(r.content)),'the every-word query is used when it finds five');
 } finally {await db.close();}
});

test('hybrid search: a file named for the question is found by its name', async () => {
 const db=await hybridDatabase();
 try {
  const nov=await projectDoc(db,'Novation',[{file:'180629-SWPCL-GE-FSA-Novation-Executed.pdf'}]);
  await passage(db,{version:nov.versions[0].id,docId:nov.docId,path:nov.versions[0].path,content:'THIS DEED is made on 29 June 2018 between the parties.',embedding:[0,0,1]});
  const fsa=await projectDoc(db,'FSA',[{file:'111013-Full-Services-Agreement.pdf'}]);
  await passage(db,{version:fsa.versions[0].id,docId:fsa.docId,path:fsa.versions[0].path,content:'The Full Services Agreement term is eight years.',embedding:[1,0,0]});
  const rows=await search(db,{q:'which document novated the FSA',emb:[1,0,0]});
  const hit=rows.find(r=>r.matter_document_id===nov.docId);
  assert.ok(hit,'the novation is found although no passage says "novated"');
  assert.equal(hit.name_rank,1);
  // One word naming one file is enough; a word in many names is not.
  const sha=await projectDoc(db,'SHA',[{file:'1788590751052-SHA0522 _Execution Version_.docx'}]);
  await passage(db,{version:sha.versions[0].id,docId:sha.docId,path:sha.versions[0].path,content:'Recitals.',embedding:[0,1,0]});
  const byName=await search(db,{q:'deadlock resolution mechanism in SHA0522',emb:[1,0,0]});
  assert.equal(byName.find(r=>r.name_rank!==null)?.matter_document_id,sha.docId);
  assert.equal(byName.filter(r=>r.name_rank!==null).length,1);
 } finally {await db.close();}
});

test('hybrid search: precedents are searched by paragraph, statutes within the named Acts', async () => {
 const db=await hybridDatabase();
 try {
  const body='<p>1. Definitions</p><p>Drag-Along Notice means a notice served by the Majority Shareholder under Clause 9.</p><p>9.1 The Majority Shareholder may require the minority to sell on the same terms (drag along).</p>';
  const prec=(await db.query(`insert into documents(content,metadata,is_precedent,embedding) values($1,$2,true,$3) returning id`,[body,JSON.stringify({storage_path:'precedent/x/JVA.docx',filename:'12. JVA.docx'}),vec([0,1,0])])).rows[0].id;
  const rows=await search(db,{q:'drag along clause',scope:'precedent',matter:null,emb:[0,1,0]});
  assert.ok(rows.length>=1&&rows.length<=3);
  assert.ok(rows.every(r=>r.id===prec));
  assert.ok(rows.every(r=>!r.content.includes('<p>')),'a paragraph, not the whole row');
  assert.ok(rows.some(r=>/drag along/i.test(r.content)));
  assert.ok(rows.every(r=>Number.isInteger(r.metadata.passage_ordinal)));
  for(let i=0;i<5;i++) await db.query(`insert into documents(content,metadata,is_statute) values($1,$2,true)`,[`${70+i}. Compensation for breach of contract.— text ${i}`,JSON.stringify({act_name:'Contract Act, 1872'})]);
  await db.query(`insert into documents(content,metadata,is_statute) values($1,$2,true)`,['5. Compensation for breach.',JSON.stringify({act_name:'Other Act'})]);
  const named=await search(db,{q:'compensation breach',scope:'statute',matter:null,acts:['Contract Act, 1872']});
  assert.equal(named.length,5,'one Act named: every passage that ranks, no per-Act cap');
  assert.ok(named.every(r=>r.metadata.act_name==='Contract Act, 1872'));
  const any=await search(db,{q:'compensation breach',scope:'statute',matter:null});
  assert.equal(any.filter(r=>r.metadata.act_name==='Contract Act, 1872').length,3,'no Act named: at most three from one Act');
  assert.equal(any.filter(r=>r.metadata.act_name==='Other Act').length,1);
 } finally {await db.close();}
});

test('hybrid search (18 Oct): a precedent file is found by its name once, by its row closest to the question; a row with no storage path is its own file', async () => {
 const db=await hybridDatabase();
 try {
  const prec=async(path,filename,body,emb)=>(await db.query(`insert into documents(content,metadata,is_precedent,embedding) values($1,$2,true,$3) returning id`,
   [body,JSON.stringify(path?{storage_path:path,filename}:{filename}),vec(emb)])).rows[0].id;
  const far=await prec('precedent/a/1788590751052-SHA0522 _Execution Version_.docx','1788590751052-SHA0522 _Execution Version_.docx','<p>Recitals: the shareholders wish to record their arrangements.</p>',[0,0,1]);
  const near=await prec('precedent/a/1788590751052-SHA0522 _Execution Version_.docx','1788590751052-SHA0522 _Execution Version_.docx','<p>Schedule 1: the shareholders and the shares each of them holds.</p>',[0,1,0]);
  await prec('precedent/b/12. JVA.docx','12. JVA.docx','<p>Deadlock between the joint venture partners goes to the chairmen.</p>',[1,0,0]);
  const mou=await prec(null,'MOU SIAC Singapore.docx','<p>Disputes are finally resolved by arbitration under the rules in force.</p>',[1,0,0]);
  const byName=(await search(db,{q:'deadlock resolution mechanism in SHA0522',scope:'precedent',matter:null,emb:[0,1,0]})).filter(r=>r.name_rank!==null);
  assert.equal(byName.length,1,'one file, one passage from the name leg');
  assert.equal(byName[0].id,near,'the file is represented by its row closest to the question');
  assert.ok(byName[0].id!==far);
  const own=(await search(db,{q:'SIAC arbitration seated in singapore',scope:'precedent',matter:null,emb:[0,1,0]})).filter(r=>r.name_rank!==null);
  assert.deepEqual(own.map(r=>r.id),[mou],'a row with no storage path is found by its own file name');
 } finally {await db.close();}
});

test('hybrid search (18 Oct): common precedent words come from the statistics once the paragraphs are analysed, counted until then', async () => {
 const db=await hybridDatabase();
 try {
  const paras=Array.from({length:12},(_,i)=>`<p>${i}. This agreement binds the parties and their successors${i<2?' and the drag along right applies':''}.</p>`).join('');
  await db.query(`insert into documents(content,metadata,is_precedent) values($1,$2,true)`,[paras,JSON.stringify({storage_path:'precedent/c/SSA.docx',filename:'SSA.docx'})]);
  assert.equal((await db.query(`select public.precedent_common_lexemes(array['agreement','drag'],5) as w`)).rows[0].w,null,'no statistics yet: null, and the function counts');
  const before=await search(db,{q:'drag along agreement example',scope:'precedent',matter:null});
  await db.exec('analyze precedent_passages');
  assert.deepEqual((await db.query(`select public.precedent_common_lexemes(array['agreement','drag'],5) as w`)).rows[0].w,['agreement'],'a word in at least 5 paragraphs by the statistics is common');
  assert.deepEqual((await db.query(`select public.precedent_common_lexemes(array['agreement','drag'],50) as w`)).rows[0].w,[]);
  const after=await search(db,{q:'drag along agreement example',scope:'precedent',matter:null});
  assert.deepEqual(after.map(r=>[r.metadata.passage_ordinal,r.keyword_rank]),before.map(r=>[r.metadata.passage_ordinal,r.keyword_rank]),'the same results whether counted or read from the statistics');
  assert.ok(after.length>=1&&/drag along/.test(after[0].content),'the paragraph holding the most words first');
  await db.exec('set role authenticated');
  assert.deepEqual((await db.query(`select public.precedent_common_lexemes(array['agreement'],5) as w`)).rows[0].w,['agreement'],'a signed-in member reads them too (pg_stats hides a row-secured table from them)');
  await db.exec('reset role');
 } finally {await db.close();}
});

test('hybrid search (18 Oct): with Acts named, every leg runs on those Acts and the nearest in meaning ranks first', async () => {
 const db=await hybridDatabase();
 try {
  const act=async(content,meta,emb)=>(await db.query(`insert into documents(content,metadata,is_statute,embedding) values($1,$2,true,$3) returning id`,[content,JSON.stringify(meta),vec(emb)])).rows[0].id;
  const a=await act('73. Compensation for loss caused by breach of contract.',{act_name:'Contract Act, 1872'},[0,1,0]);
  const b=await act('74. Compensation for breach where penalty stipulated for.',{act_name:'Contract Act, 1872'},[1,0,0]);
  const amend=await act('2. Section 74 is amended.',{act_name:'Contract (Amendment) Act, 2020',amends_act:'Contract Act, 1872'},[0.9,0.1,0]);
  await act('5. Compensation for breach.',{act_name:'Other Act'},[1,0,0]);
  const rows=await search(db,{q:'penalty stipulated',scope:'statute',matter:null,acts:['Contract Act, 1872'],emb:[1,0,0]});
  assert.deepEqual(rows.map(r=>r.id).sort(),[a,b,amend].sort(),'the Act and its amendment, nothing else');
  assert.equal(rows.find(r=>r.vector_rank===1).id,b);
  assert.equal(rows[0].id,b,'nearest in meaning and a keyword hit');
  assert.deepEqual(await search(db,{q:'penalty',scope:'statute',matter:null,acts:['No Such Act'],emb:[1,0,0]}),[]);
 } finally {await db.close();}
});

test('hybrid search: the migration refuses to run before the indexing pipeline migration', async () => {
 const db=await database();
 try {
  await db.exec('create domain public.vector as float8[]');
  await assert.rejects(db.exec(hybridSql()),/Apply 20261017090000_indexing_pipeline.sql first/);
 } finally {await db.close();}
});
