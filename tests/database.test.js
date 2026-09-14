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
