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
